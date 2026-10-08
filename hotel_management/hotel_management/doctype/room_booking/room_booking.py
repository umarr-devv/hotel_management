# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, get_datetime, time_diff_in_hours

from hotel_management.billing import (
	OUTDATED,
	add_payer_names,
	cancel_sales_invoice,
	get_billing,
	get_currency_precision,
	get_invoice_states,
	get_pay_status,
	get_rate_with_markup,
	set_payer_amounts,
	update_pay_status,
)
from hotel_management.hotel_management.doctype.group_booking.group_booking import update_group_totals
from hotel_management.utils import hours_to_days, is_room_active

# от этих полей и строк зависят суммы брони и её плательщиков
PRICING_FIELDS = ("room", "room_rate", "check_in", "check_out")
ITEM_FIELDS = ("item", "price_list", "qty", "rate", "markup", "payer")
PERCENTAGE_SERVICE_FIELDS = ("item", "percent", "qty")
PAYER_FIELDS = ("payer", "share")
NUMERIC_ROW_FIELDS = {"qty", "rate", "markup", "percent", "share"}

# допуск при проверке суммы долей плательщиков
SHARE_TOLERANCE = 0.01


class RoomBooking(Document):
	def onload(self):
		# форма по счетам плательщиков показывает сводку, кнопки и блокирует поля
		self.set_onload("billing", add_payer_names(get_billing(self)))

	def validate(self):
		self.set_default_payers()
		self.restore_invoice_links()

		# validate() контроллера вызывается ДО стандартной проверки обязательных полей.
		# Если чего-то не хватает — выходим и даём Frappe показать понятное
		# «Заполните обязательные поля», вместо ложных ошибок про даты/тариф.
		if not (self.room and self.room_rate and self.check_in and self.check_out):
			return

		self.validate_room()
		self.validate_dates()
		self.set_rate_per_day()
		self.calculate_totals()
		self.validate_payers()
		self.validate_paid_payers()
		self.validate_overlap()
		self.pay_status = get_pay_status(get_billing(self))

	def before_update_after_submit(self):
		# После проведения разрешено только продление/сокращение (check_out),
		# изменение доп. и процентных услуг и плательщиков. Тариф остаётся зафиксированным.
		self.restore_invoice_links()
		if self.has_value_changed("check_out") and self.status != "Checked In":
			frappe.throw(_("Check Out can only be changed for a checked in booking"))

		# смена статуса по workflow суммы не пересчитывает
		before = self.get_doc_before_save()
		if before and not self.pricing_changed(before):
			return

		self.validate_dates()
		self.calculate_totals()
		self.validate_payers()
		self.validate_paid_payers()
		self.validate_overlap()
		self.pay_status = get_pay_status(get_billing(self))

	def on_update(self):
		self.after_pricing_saved()

	def on_update_after_submit(self):
		self.after_pricing_saved()

	def on_trash(self):
		# удалённая бронь выходит из группы, иначе строка группы не даст её удалить
		if self.group_booking:
			frappe.db.delete("Group Booking Room", {"room_booking": self.name})

	def before_cancel(self):
		# отменить можно только бронь без оплат: счёт с оплатами отменить нельзя
		paid = [
			name
			for name, state in get_invoice_states(row.sales_invoice for row in self.payers).items()
			if state.has_payments
		]
		if paid:
			frappe.throw(
				_("Booking {0} cannot be cancelled: Sales Invoice {1} already has payments").format(
					frappe.bold(self.name), frappe.bold(", ".join(paid))
				),
				title=_("Booking is paid"),
			)

	def on_cancel(self):
		# счета — часть брони: отменяем их, даже если у пользователя нет прав на счета.
		# Общий счёт группы тоже отменяется — его заново выставят по оставшимся броням.
		invoices = list(dict.fromkeys(row.sales_invoice for row in self.payers if row.sales_invoice))
		others = set()
		for name in invoices:
			others.update(get_other_invoice_bookings(name, self.name))
			cancel_sales_invoice(name, ignore_permissions=True)
		update_pay_status(others)
		if self.group_booking:
			update_group_totals(self.group_booking, update_modified=True)

	def after_pricing_saved(self):
		before = self.get_doc_before_save()
		if before and not self.pricing_changed(before):
			return
		self.cancel_orphan_invoices(before)
		self.warn_outdated_invoices(before)
		self.update_group_row()

	# --- плательщики ------------------------------------------------------------

	def set_default_payers(self):
		"""Без плательщиков платит заказчик; единственный плательщик-заказчик меняется вместе с ним."""
		if not self.customer:
			return
		if not self.payers:
			self.append("payers", {"payer": self.customer, "share": 100})
			return

		before = self.get_doc_before_save()
		if before and before.customer != self.customer and len(self.payers) == 1:
			row = self.payers[0]
			if row.payer == before.customer and not row.sales_invoice:
				row.payer = self.customer

	def restore_invoice_links(self):
		"""Счёт плательщика ставит только сервер: ссылки берём из сохранённой брони по плательщику."""
		before = self.get_doc_before_save()
		invoices = {row.payer: row.sales_invoice for row in before.payers} if before else {}
		for row in self.payers:
			row.sales_invoice = invoices.get(row.payer)

	def validate_payers(self):
		if not self.payers:
			frappe.throw(_("Add at least one payer"))

		payers = [row.payer for row in self.payers]
		duplicates = {payer for payer in payers if payers.count(payer) > 1}
		if duplicates:
			frappe.throw(_("Payer {0} is listed more than once").format(frappe.bold(", ".join(duplicates))))

		total_share = sum(flt(row.share) for row in self.payers)
		if abs(total_share - 100) > SHARE_TOLERANCE:
			frappe.throw(
				_("Payer shares must add up to 100% (now {0}%)").format(flt(total_share, 2)),
				title=_("Payers"),
			)

		for row in self.items_and_service:
			if row.payer and row.payer not in payers:
				frappe.throw(
					_("Row #{0}: payer {1} of item {2} is not in the Payers table").format(
						row.idx, frappe.bold(row.payer), frappe.bold(row.item)
					)
				)

	def validate_paid_payers(self):
		"""Сумма плательщика, по счёту которого уже есть оплата, меняться не может."""
		before = self.get_doc_before_save()
		if not before:
			return

		states = get_invoice_states(row.sales_invoice for row in before.payers)
		precision = get_currency_precision()
		current = {row.payer: row for row in self.payers}
		for old in before.payers:
			state = states.get(old.sales_invoice)
			if not (state and state.has_payments):
				continue
			row = current.get(old.payer)
			new_amount = flt(row.amount, precision) if row else 0
			if not row or new_amount != flt(old.amount, precision):
				frappe.throw(
					_(
						"Sales Invoice {0} of payer {1} already has payments: the payer's amount can no longer change ({2} → {3})"
					).format(
						frappe.bold(old.sales_invoice),
						frappe.bold(old.payer),
						frappe.bold(flt(old.amount, precision)),
						frappe.bold(new_amount),
					),
					title=_("Booking is paid"),
				)

	def cancel_orphan_invoices(self, before):
		"""Счета, которые больше не нужны ни одному плательщику, отменяем (оплат по ним нет)."""
		if not before:
			return
		current = {row.sales_invoice for row in self.payers if row.sales_invoice}
		for row in before.payers:
			name = row.sales_invoice
			if name and name not in current and not get_other_invoice_bookings(name, self.name):
				cancel_sales_invoice(name, ignore_permissions=True)

	def warn_outdated_invoices(self, before):
		"""Сумма плательщика изменилась после выставления счёта — счёт сам не меняется."""
		if not before:
			return
		outdated = [row.sales_invoice for row in get_billing(self) if row.status == OUTDATED]
		if not outdated:
			return
		frappe.msgprint(
			_(
				"Booking total changed ({0} → {1}), but invoices {2} still hold the old amounts. Recreate the invoices."
			).format(
				frappe.bold(flt(before.total_amount)),
				frappe.bold(flt(self.total_amount)),
				frappe.bold(", ".join(dict.fromkeys(outdated))),
			),
			title=_("Invoice is outdated"),
			indicator="orange",
		)

	def update_group_row(self):
		"""Бронь изменили в её форме — переносим номер, тариф и даты в строку группы.

		Группа при этом отмечается изменённой: её открытая форма с прежними значениями
		не сохранится поверх, а попросит перезагрузку.
		"""
		if not self.group_booking or self.flags.from_group:
			return
		for name in frappe.get_all("Group Booking Room", filters={"room_booking": self.name}, pluck="name"):
			frappe.db.set_value(
				"Group Booking Room",
				name,
				{
					"room": self.room,
					"room_rate": self.room_rate,
					"check_in": self.check_in,
					"check_out": self.check_out,
				},
				update_modified=False,
			)
		update_group_totals(self.group_booking, update_modified=True)

	# --- validations ---------------------------------------------------------

	def pricing_changed(self, before):
		"""Изменилось ли то, от чего зависят суммы: номер, тариф, даты, услуги или плательщики."""
		return (
			any(self.has_value_changed(field) for field in PRICING_FIELDS)
			or rows_signature(self.items_and_service, ITEM_FIELDS)
			!= rows_signature(before.items_and_service, ITEM_FIELDS)
			or rows_signature(self.percentage_services, PERCENTAGE_SERVICE_FIELDS)
			!= rows_signature(before.percentage_services, PERCENTAGE_SERVICE_FIELDS)
			or rows_signature(self.payers, PAYER_FIELDS) != rows_signature(before.payers, PAYER_FIELDS)
		)

	def validate_room(self):
		# новая бронь или смена номера — только на включённый номер включённого типа;
		# старые брони отключённого номера при этом можно сохранять
		if self.has_value_changed("room") and not is_room_active(self.room):
			frappe.throw(_("Room {0} or its room type is disabled").format(frappe.bold(self.room)))

	def validate_dates(self):
		if get_datetime(self.check_out) <= get_datetime(self.check_in):
			frappe.throw(_("Check Out must be after Check In"))

	def validate_overlap(self):
		conflict = get_overlapping_booking(self.room, self.check_in, self.check_out, exclude=self.name)
		if conflict:
			frappe.throw(
				_("Room {0} is already booked for this period (overlaps booking {1})").format(
					frappe.bold(self.room), frappe.bold(conflict)
				),
				title=_("Room is occupied"),
			)

	# --- calculations --------------------------------------------------------

	def set_rate_per_day(self):
		room_type = frappe.db.get_value("Hotel Room", self.room, "room_type")
		rate = frappe.db.get_value(
			"Room Type Rate",
			{"parent": room_type, "parenttype": "Room Type", "room_rate": self.room_rate, "enabled": 1},
			"rate_per_day",
		)
		if rate is None:
			frappe.throw(
				_("No active rate {0} for room type {1}").format(
					frappe.bold(self.room_rate), frappe.bold(room_type)
				)
			)
		self.rate_per_day = flt(rate)

	def calculate_totals(self):
		self.total_hours = flt(
			time_diff_in_hours(self.check_out, self.check_in), self.precision("total_hours")
		)
		# тариф суточный: платятся начатые сутки (25 ч — 2 суток)
		self.total_days = hours_to_days(self.total_hours)
		self.amount = flt(self.rate_per_day * self.total_days, self.precision("amount"))

		items_amount = 0
		for row in self.items_and_service:
			if not row.rate and row.item and row.price_list:
				row.rate = flt(
					frappe.db.get_value(
						"Item Price", {"item_code": row.item, "price_list": row.price_list}, "price_list_rate"
					)
				)
			row.amount = flt(get_rate_with_markup(row) * flt(row.qty), row.precision("amount"))
			items_amount += row.amount

		self.items_and_serivce_amount = flt(items_amount, self.precision("items_and_serivce_amount"))

		# процентные услуги: цена = процент от суточного тарифа номера, количество всегда 1
		percentage_amount = 0
		for row in self.percentage_services:
			row.qty = 1
			row.rate = flt(flt(self.rate_per_day) * flt(row.percent) / 100, row.precision("rate"))
			row.amount = row.rate
			percentage_amount += row.amount

		self.percentage_services_amount = flt(percentage_amount, self.precision("percentage_services_amount"))
		self.total_amount = flt(
			self.amount + self.items_and_serivce_amount + self.percentage_services_amount,
			self.precision("total_amount"),
		)
		set_payer_amounts(self)


def rows_signature(rows, fields):
	"""Значимые поля строк таблицы — чтобы заметить любое изменение состава услуг."""
	return [
		tuple(flt(row.get(field), 6) if field in NUMERIC_ROW_FIELDS else row.get(field) for field in fields)
		for row in rows
	]


def get_other_invoice_bookings(sales_invoice, booking):
	"""Другие действующие брони со ссылкой на тот же счёт (общий счёт группы)."""
	return frappe.db.sql_list(
		"""
		select distinct p.parent
		from `tabRoom Booking Payer` p
		inner join `tabRoom Booking` b on b.name = p.parent
		where p.parenttype = 'Room Booking' and b.docstatus < 2
			and p.sales_invoice = %s and p.parent != %s
		""",
		(sales_invoice, booking),
	)


def get_overlapping_booking(room, check_in, check_out, exclude=None):
	"""Вернуть имя брони, пересекающейся с периодом [check_in, check_out) в номере room."""
	filters = {
		"room": room,
		"docstatus": ["<", 2],
		"status": ["!=", "Cancelled"],
		"check_in": ["<", check_out],
		"check_out": [">", check_in],
	}
	if exclude:
		filters["name"] = ["!=", exclude]
	return frappe.db.exists("Room Booking", filters)
