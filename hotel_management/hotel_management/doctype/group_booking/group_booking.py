# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Групповая бронь: несколько номеров одной группы (свадьба, конференция, турагентство).

Каждый номер группы — обычная Room Booking со ссылкой на группу: проверка пересечений,
шахматка, статусы заезда и выезда и отчёты работают с ней как с одиночной бронью.
Группа при сохранении создаёт и обновляет свои брони и задаёт им плательщиков по
схеме оплаты (billing):
  * Organizer Pays All — всё платит организатор, один общий счёт группы;
  * Organizer Pays Accommodation — проживание платит организатор (общий счёт группы),
    доп. услуги — гость номера;
  * Guests Pay — гость номера сам платит за свой номер.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.workflow import apply_workflow, get_transitions
from frappe.utils import cint, flt, get_datetime

from hotel_management import billing
from hotel_management.utils import active_room_filters

ORGANIZER_PAYS_ALL = "Organizer Pays All"
ORGANIZER_PAYS_ACCOMMODATION = "Organizer Pays Accommodation"
GUESTS_PAY = "Guests Pay"

DATETIME_FIELDS = {"check_in", "check_out"}


class GroupBooking(Document):
	def onload(self):
		self.set_onload("summary", get_group_summary(self))

	def validate(self):
		self.restore_server_fields()
		self.validate_dates()
		self.set_row_defaults()
		self.validate_rows()
		self.validate_removed_rows()

	def on_update(self):
		self.sync_bookings()
		# итоги — и в базе, и в документе, который вернётся в форму
		self.update(update_group_totals(self.name))

	def on_trash(self):
		# вместе с группой удаляются её черновые брони; заселённые — только после отмены
		for name in get_group_bookings(self.name):
			docstatus = frappe.db.get_value("Room Booking", name, "docstatus")
			if docstatus == 1:
				frappe.throw(
					_("Booking {0} is already checked in: cancel it before deleting the group").format(
						frappe.bold(name)
					)
				)
			if docstatus == 0:
				frappe.delete_doc("Room Booking", name)

	# --- проверки --------------------------------------------------------------

	def restore_server_fields(self):
		"""Ссылки на брони и счёт и итоги ставит только сервер: берём их из сохранённой группы."""
		before = self.get_doc_before_save()
		links = {row.name: row.room_booking for row in before.rooms} if before else {}
		for row in self.rooms:
			row.room_booking = links.get(row.name)
		for field in ("sales_invoice", "total_rooms", "total_amount"):
			self.set(field, before.get(field) if before else None)

	def validate_dates(self):
		if self.check_in and self.check_out and get_datetime(self.check_out) <= get_datetime(self.check_in):
			frappe.throw(_("Check Out must be after Check In"))

	def set_row_defaults(self):
		# пустые тариф и даты строки берутся из группы
		for row in self.rooms:
			row.room_rate = row.room_rate or self.room_rate
			row.check_in = row.check_in or self.check_in
			row.check_out = row.check_out or self.check_out

	def validate_rows(self):
		for row in self.rooms:
			if row.check_in and row.check_out and get_datetime(row.check_out) <= get_datetime(row.check_in):
				frappe.throw(_("Row #{0}: Check Out must be after Check In").format(row.idx))

	def validate_removed_rows(self):
		"""Убрать из группы можно только номер с черновой (не заселённой) бронью."""
		before = self.get_doc_before_save()
		if not before:
			return
		current = {row.room_booking for row in self.rooms if row.room_booking}
		for row in before.rooms:
			if not row.room_booking or row.room_booking in current:
				continue
			if frappe.db.get_value("Room Booking", row.room_booking, "docstatus") == 1:
				frappe.throw(
					_(
						"Booking {0} is already checked in: cancel it before removing the room from the group"
					).format(frappe.bold(row.room_booking))
				)

	# --- брони группы ----------------------------------------------------------

	def sync_bookings(self):
		"""Создать брони новых строк, обновить изменённые, удалить черновики убранных строк."""
		before = self.get_doc_before_save()
		old_rows = {row.name: row for row in before.rooms} if before else {}

		current = {row.room_booking for row in self.rooms if row.room_booking}
		for row in old_rows.values():
			if row.room_booking and row.room_booking not in current:
				if frappe.db.get_value("Room Booking", row.room_booking, "docstatus") == 0:
					frappe.delete_doc("Room Booking", row.room_booking)

		billing_changed = not before or before.billing != self.billing or before.organizer != self.organizer
		for row in self.rooms:
			old = old_rows.get(row.name)
			reset_payers = billing_changed or not old or old.guest != row.guest
			self.sync_booking(row, reset_payers)

	def sync_booking(self, row, reset_payers):
		if row.room_booking:
			booking = frappe.get_doc("Room Booking", row.room_booking)
			if booking.docstatus == 2:
				return
		else:
			booking = frappe.new_doc("Room Booking")
			booking.group_booking = self.name

		values = {
			"company": self.company,
			"hotel_profile": self.hotel_profile,
			"room": row.room,
			"room_rate": row.room_rate,
			"check_in": row.check_in,
			"check_out": row.check_out,
		}
		# заказчика заселённой брони не меняем: за оплату отвечают плательщики
		if booking.docstatus == 0:
			values["customer"] = row.guest or self.organizer

		changed = booking.is_new()
		for field, value in values.items():
			if not same_value(field, booking.get(field), value):
				booking.set(field, value)
				changed = True

		if row.guest and row.guest not in [guest.guest for guest in booking.guests]:
			booking.append("guests", {"guest": row.guest})
			changed = True

		if reset_payers and set_group_payers(booking, self, row.guest):
			changed = True

		if not changed:
			return

		booking.flags.from_group = True
		if booking.is_new():
			booking.insert()
			row.db_set("room_booking", booking.name, update_modified=False)
		else:
			booking.save()


def get_group_payers(billing_mode, organizer, guest):
	"""Плательщики брони группы по схеме оплаты: [(плательщик, доля)]."""
	if billing_mode == GUESTS_PAY:
		return [(guest or organizer, 100)]
	if billing_mode == ORGANIZER_PAYS_ACCOMMODATION and guest and guest != organizer:
		# доля гостя нулевая: ему достаются только доп. услуги (он заказчик брони)
		return [(organizer, 100), (guest, 0)]
	return [(organizer, 100)]


def set_group_payers(booking, group, guest):
	"""Задать брони плательщиков группы; True — если они изменились."""
	payers = get_group_payers(group.billing, group.organizer, guest)
	if [(row.payer, flt(row.share)) for row in booking.payers] == [(p, flt(s)) for p, s in payers]:
		return False

	booking.set("payers", [{"payer": payer, "share": share} for payer, share in payers])
	# услуги плательщиков, которых больше нет, переходят к плательщику по умолчанию
	names = {payer for payer, _share in payers}
	for item in booking.items_and_service:
		if item.payer and item.payer not in names:
			item.payer = None
	return True


def same_value(field, current, value):
	if field in DATETIME_FIELDS:
		return bool(current and value) and get_datetime(current) == get_datetime(value)
	return (current or "") == (value or "")


def get_group_bookings(group_booking):
	"""Все брони группы, в порядке создания."""
	return frappe.get_all(
		"Room Booking", filters={"group_booking": group_booking}, pluck="name", order_by="creation asc"
	)


def update_group_totals(group_booking, update_modified=False):
	"""Число номеров и сумма действующих броней группы."""
	rows = frappe.get_all(
		"Room Booking",
		filters={"group_booking": group_booking, "docstatus": ["<", 2]},
		fields=["total_amount"],
	)
	totals = {"total_rooms": len(rows), "total_amount": sum(flt(row.total_amount) for row in rows)}
	frappe.db.set_value("Group Booking", group_booking, totals, update_modified=update_modified)
	return totals


def get_group_summary(group):
	"""Брони группы, их счета и доступные действия workflow — для формы группы."""
	bookings = []
	invoices = {}
	actions = {}
	needs_invoices = False

	for name in get_group_bookings(group.name):
		booking = frappe.get_doc("Room Booking", name)
		bookings.append(
			{
				"name": booking.name,
				"room": booking.room,
				"customer": booking.customer,
				"check_in": booking.check_in,
				"check_out": booking.check_out,
				"status": "Cancelled" if booking.docstatus == 2 else booking.status,
				"pay_status": booking.pay_status,
				"total_amount": flt(booking.total_amount),
			}
		)
		if booking.docstatus == 2:
			continue

		rows = billing.get_billing(booking)
		needs_invoices = needs_invoices or any(row.status in billing.NEEDS_INVOICE for row in rows)
		for row in rows:
			if row.sales_invoice and row.sales_invoice not in invoices:
				invoices[row.sales_invoice] = row

		for transition in get_transitions({"doctype": "Room Booking", "name": name}):
			actions[transition.action] = actions.get(transition.action, 0) + 1

	return {
		"bookings": bookings,
		"invoices": billing.add_payer_names(list(invoices.values())),
		"actions": [{"action": action, "count": count} for action, count in actions.items()],
		"needs_invoices": needs_invoices,
	}


# --- API ----------------------------------------------------------------------


@frappe.whitelist()
def get_free_rooms(
	check_in: str,
	check_out: str,
	room_type: str | None = None,
	hotel_building: str | None = None,
	room_rate: str | None = None,
	exclude: str | list | None = None,
	count: int | None = None,
):
	"""Номера, свободные на весь период, с тарифом для каждого.

	Тариф — room_rate, если он есть у типа номера, иначе первый активный тариф типа.
	"""
	if get_datetime(check_out) <= get_datetime(check_in):
		frappe.throw(_("Check Out must be after Check In"))

	filters = active_room_filters()
	if room_type:
		filters.append(["room_type", "=", room_type])
	if hotel_building:
		filters.append(["hotel_building", "=", hotel_building])
	rooms = frappe.get_list(
		"Hotel Room",
		filters=filters,
		fields=["name", "room_type", "room_number"],
		limit_page_length=0,
	)

	busy = set(
		frappe.get_all(
			"Room Booking",
			filters={
				"docstatus": ["<", 2],
				"status": ["!=", "Cancelled"],
				"check_in": ["<", check_out],
				"check_out": [">", check_in],
			},
			pluck="room",
		)
	)
	exclude = set(frappe.parse_json(exclude) or [])
	free = [room for room in rooms if room.name not in busy and room.name not in exclude]
	free.sort(key=lambda room: (room.room_type or "", natural_key(room.room_number or room.name)))
	if cint(count):
		free = free[: cint(count)]

	rates = {}
	for row in frappe.get_all(
		"Room Type Rate",
		filters={
			"parenttype": "Room Type",
			"parent": ["in", list({room.room_type for room in free})],
			"enabled": 1,
		},
		fields=["parent", "room_rate"],
		order_by="idx asc",
	):
		rates.setdefault(row.parent, []).append(row.room_rate)
	for room in free:
		available = rates.get(room.room_type) or []
		room.room_rate = room_rate if room_rate in available else (available[0] if available else None)
	return free


@frappe.whitelist()
def make_group_invoices(group_booking: str):
	"""Выставить недостающие и пересоздать устаревшие счета всех броней группы."""
	group = frappe.get_doc("Group Booking", group_booking)
	group.check_permission("write")

	created = []
	for name in get_group_bookings(group.name):
		booking = frappe.get_doc("Room Booking", name)
		if booking.docstatus < 2:
			created.extend(billing.make_booking_invoices(booking))

	created = list(dict.fromkeys(created))
	if not created:
		frappe.msgprint(_("All invoices are up to date"))
	return created


@frappe.whitelist()
def apply_group_action(group_booking: str, action: str):
	"""Применить действие workflow (заселить, выселить, завершить) ко всем броням группы, где оно доступно."""
	group = frappe.get_doc("Group Booking", group_booking)
	group.check_permission("write")

	done = []
	for name in get_group_bookings(group.name):
		doc = {"doctype": "Room Booking", "name": name}
		if frappe.db.get_value("Room Booking", name, "docstatus") == 2:
			continue
		if any(transition.action == action for transition in get_transitions(doc)):
			apply_workflow(doc, action)
			done.append(name)

	if not done:
		frappe.throw(_("No bookings of the group can take the action {0}").format(frappe.bold(_(action))))
	return done


def natural_key(value):
	"""«101», «№7», «VIP 7» → сортировка по самому номеру."""
	digits = "".join(ch for ch in str(value) if ch.isdigit())
	return (int(digits) if digits else 0, str(value))
