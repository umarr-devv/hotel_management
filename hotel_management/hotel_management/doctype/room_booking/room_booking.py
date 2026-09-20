# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, get_datetime, time_diff_in_hours


class RoomBooking(Document):
	def validate(self):
		# validate() контроллера вызывается ДО стандартной проверки обязательных полей.
		# Если чего-то не хватает — выходим и даём Frappe показать понятное
		# «Заполните обязательные поля», вместо ложных ошибок про даты/тариф.
		if not (self.room and self.room_rate and self.check_in and self.check_out):
			return

		self.validate_dates()
		self.set_rate_by_hour()
		self.calculate_totals()
		self.validate_overlap()

	def before_update_after_submit(self):
		# После проведения разрешено только продление/сокращение (check_out)
		# и изменение доп. услуг. Тариф остаётся зафиксированным.
		if self.has_value_changed("check_out") and self.status != "Checked In":
			frappe.throw(_("Дату выезда можно менять только у заселённой брони (Checked In)"))

		old_total = flt(self.get_doc_before_save() and self.get_doc_before_save().total_amount)
		self.validate_dates()
		self.calculate_totals()
		self.validate_overlap()
		self.warn_outdated_invoice(old_total)

	def warn_outdated_invoice(self, old_total):
		"""Сумма брони изменилась после выставления счёта — предупреждаем, счёт сам не меняется."""
		if not self.sales_invoice or flt(old_total) == flt(self.total_amount):
			return
		frappe.msgprint(
			_("Сумма брони изменилась ({0} → {1}), а счёт {2} выставлен на старую сумму. Пересоздайте счёт.").format(
				frappe.bold(old_total), frappe.bold(self.total_amount), frappe.bold(self.sales_invoice)
			),
			title=_("Счёт устарел"),
			indicator="orange",
		)

	# --- validations ---------------------------------------------------------

	def validate_dates(self):
		if get_datetime(self.check_out) <= get_datetime(self.check_in):
			frappe.throw(_("Check Out должен быть позже Check In"))

	def validate_overlap(self):
		conflict = get_overlapping_booking(self.room, self.check_in, self.check_out, exclude=self.name)
		if conflict:
			frappe.throw(
				_("Номер {0} уже забронирован на этот период (пересекается с бронированием {1})").format(
					frappe.bold(self.room), frappe.bold(conflict)
				),
				title=_("Номер занят"),
			)

	# --- calculations --------------------------------------------------------

	def set_rate_by_hour(self):
		room_type = frappe.db.get_value("Hotel Room", self.room, "room_type")
		rate = frappe.db.get_value(
			"Room Type Rate",
			{"parent": room_type, "parenttype": "Room Type", "room_rate": self.room_rate, "enabled": 1},
			"rate_by_hour",
		)
		if rate is None:
			frappe.throw(
				_("Нет активного тарифа {0} для типа номера {1}").format(
					frappe.bold(self.room_rate), frappe.bold(room_type)
				)
			)
		self.rate_by_hour = flt(rate)

	def calculate_totals(self):
		self.total_hours = flt(time_diff_in_hours(self.check_out, self.check_in), self.precision("total_hours"))
		self.amount = flt(self.rate_by_hour * self.total_hours, self.precision("amount"))

		items_amount = 0
		for row in self.items_and_service:
			if not row.rate and row.item and row.price_list:
				row.rate = flt(
					frappe.db.get_value(
						"Item Price", {"item_code": row.item, "price_list": row.price_list}, "price_list_rate"
					)
				)
			row.amount = flt(flt(row.rate) * flt(row.qty), row.precision("amount"))
			items_amount += row.amount

		self.items_and_serivce_amount = flt(items_amount, self.precision("items_and_serivce_amount"))
		self.total_amount = flt(self.amount + self.items_and_serivce_amount, self.precision("total_amount"))


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
