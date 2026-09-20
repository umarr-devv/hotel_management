# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate


@frappe.whitelist()
def make_booking_payment(
	room_booking: str,
	mode_of_payment: str,
	amount: float,
	posting_date: str | None = None,
	reference_no: str | None = None,
):
	"""Создать и провести Payment Entry (Приход) по счёту брони."""
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	booking = frappe.get_doc("Room Booking", room_booking)
	booking.check_permission("read")

	if not booking.sales_invoice:
		frappe.throw(_("Create a Sales Invoice for this booking first"))

	si = frappe.get_doc("Sales Invoice", booking.sales_invoice)
	if si.docstatus != 1:
		frappe.throw(_("Sales Invoice {0} is not submitted").format(si.name))
	if flt(si.outstanding_amount) <= 0:
		frappe.throw(_("Sales Invoice {0} is already paid").format(si.name))

	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("Amount must be greater than zero"))

	# касса/банк берём из настроек способа оплаты для компании счёта
	account = get_bank_cash_account(mode_of_payment, si.company)["account"]

	pe = get_payment_entry("Sales Invoice", si.name, bank_account=account)
	pe.mode_of_payment = mode_of_payment
	pe.posting_date = getdate(posting_date or nowdate())
	pe.reference_date = pe.posting_date
	pe.reference_no = reference_no or booking.name  # обязателен для банковских счетов

	# сумму можно изменить: частичная оплата или переплата (остаток уйдёт в аванс)
	pe.paid_amount = amount
	pe.received_amount = amount
	for ref in pe.references:
		ref.allocated_amount = min(amount, flt(ref.outstanding_amount))

	pe.set_exchange_rate()
	pe.set_amounts()
	pe.insert()
	pe.submit()
	return pe.name


@frappe.whitelist()
def get_room_rates(room: str):
	"""Активные тарифы типа номера — как фильтр тарифа в полной форме брони."""
	room_type = frappe.db.get_value("Hotel Room", room, "room_type")
	if not room_type:
		return []
	frappe.has_permission("Hotel Room", "read", room, throw=True)
	return frappe.get_all(
		"Room Type Rate",
		filters={"parent": room_type, "parenttype": "Room Type", "enabled": 1},
		fields=["room_rate", "rate_by_hour"],
		order_by="idx asc",
	)


@frappe.whitelist()
def get_room_card(room: str):
	"""Данные для карточки номера на шахматке (только чтение)."""
	doc = frappe.get_doc("Hotel Room", room)
	doc.check_permission("read")

	room_type = frappe.get_doc("Room Type", doc.room_type) if doc.room_type else None

	amenities = []
	if room_type:
		names = [r.amenity for r in room_type.get("room_type_amenity") or [] if r.amenity]
		if names:
			info = {
				a.name: a
				for a in frappe.get_all(
					"Room Amenity",
					filters={"name": ["in", names]},
					fields=["name", "icon", "color", "description"],
				)
			}
			amenities = [info.get(n) or {"name": n} for n in names]

	# фото: главное изображение номера (или типа) + вложения-картинки номера (галерея)
	images = []
	for url in (doc.image, room_type and room_type.image):
		if url and url not in images:
			images.append(url)
	for f in frappe.get_all(
		"File",
		filters={"attached_to_doctype": "Hotel Room", "attached_to_name": doc.name, "is_folder": 0},
		fields=["file_url"],
		order_by="creation asc",
	):
		if f.file_url and f.file_url not in images and _is_image(f.file_url):
			images.append(f.file_url)

	floor_label = frappe.db.get_value("Hotel Floor", doc.hotel_floor, "floor_number") if doc.hotel_floor else None

	return {
		"name": doc.name,
		"room_number": doc.room_number,
		"room_type": doc.room_type,
		"hotel_building": doc.hotel_building,
		"floor": floor_label or doc.floor_number,
		"notes": doc.notes,
		"max_occupancy": room_type and room_type.max_occupancy,
		"room_size": room_type and room_type.room_size,
		"description": room_type and room_type.description,
		"amenities": amenities,
		"rates": get_room_rates(doc.name),
		"images": images,
	}


def _is_image(url: str) -> bool:
	return url.lower().rsplit(".", 1)[-1] in {"png", "jpg", "jpeg", "gif", "webp", "svg", "avif"}
