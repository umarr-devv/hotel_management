# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.core.doctype.user_permission.user_permission import get_user_permissions
from frappe.utils import cint, flt, getdate, nowdate

from hotel_management.hotel_management.doctype.hotel_profile.hotel_profile import (
	get_payment_modes as get_hotel_payment_modes,
)
from hotel_management.hotel_management.doctype.hotel_profile.hotel_profile import (
	validate_payment_mode,
)
from hotel_management.hotel_management.doctype.room_booking.room_booking import (
	cancel_sales_invoice,
	get_rate_with_markup,
)
from hotel_management.utils import active_room_filters, invoice_has_payments

# --- оплата --------------------------------------------------------------------


@frappe.whitelist()
def get_payment_modes(room_booking: str):
	"""Способы оплаты для диалога оплаты брони — из профиля отеля брони, в порядке таблицы.

	Показываются только способы, разрешённые пользователю (User Permission на Mode of Payment).
	"""
	booking = frappe.get_doc("Room Booking", room_booking)
	booking.check_permission("read")
	modes = get_hotel_payment_modes(get_booking_hotel_profile(booking))
	if not modes:
		return []

	permitted = get_permitted_payment_modes()
	if permitted is not None:
		modes = [mode for mode in modes if mode in permitted]
		if not modes:
			frappe.throw(_("You are not permitted to use any Mode of Payment from the Hotel Profile"))

	info = {
		m.name: m
		for m in frappe.get_all(
			"Mode of Payment", filters={"name": ["in", modes]}, fields=["name", "type", "enabled"]
		)
	}
	return [
		{"mode_of_payment": mode, "type": info[mode].type}
		for mode in modes
		if mode in info and info[mode].enabled
	]


def get_permitted_payment_modes():
	"""Способы оплаты, разрешённые пользователю через User Permission; None — ограничений нет.

	Учитываются разрешения для всех документов и для Payment Entry: оплата брони
	проводится через Payment Entry.
	"""
	permissions = [
		perm
		for perm in get_user_permissions().get("Mode of Payment", [])
		if not perm.get("applicable_for") or perm.get("applicable_for") == "Payment Entry"
	]
	if not permissions:
		return None
	return {perm.get("doc") for perm in permissions}


def get_booking_hotel_profile(booking):
	if not booking.hotel_profile:
		frappe.throw(_("Set Hotel Profile in Room Booking {0}").format(booking.name))
	return booking.hotel_profile


def validate_payment_modes(modes, hotel_profile):
	"""Способы оплаты указаны по разу, есть в профиле отеля и разрешены пользователю."""
	permitted = get_permitted_payment_modes()
	seen = set()
	for mode in modes:
		if not mode:
			frappe.throw(_("Mode of Payment is required"))
		validate_payment_mode(hotel_profile, mode)
		if permitted is not None and mode not in permitted:
			frappe.throw(
				_("You are not permitted to use Mode of Payment {0}").format(frappe.bold(mode)),
				frappe.PermissionError,
			)
		if mode in seen:
			frappe.throw(_("Mode of Payment {0} is listed more than once").format(frappe.bold(mode)))
		seen.add(mode)


@frappe.whitelist()
def make_booking_payments(room_booking: str, payments: str | list, posting_date: str | None = None):
	"""Сплит-оплата брони: по Payment Entry (Приход) на каждый способ оплаты с суммой больше нуля.

	payments — список {mode_of_payment, amount, reference_no}. Всё проводится в одном
	запросе: если какой-то платёж не прошёл, откатываются все.
	"""
	payments = [frappe._dict(p) for p in (frappe.parse_json(payments) or [])]
	if any(flt(p.amount) < 0 for p in payments):
		frappe.throw(_("Amount must be greater than zero"))
	payments = [p for p in payments if flt(p.amount) > 0]
	if not payments:
		frappe.throw(_("Enter an amount in at least one Mode of Payment"))

	booking, si = get_payable_invoice(room_booking)
	validate_payment_modes([p.mode_of_payment for p in payments], get_booking_hotel_profile(booking))

	# долг гасим по порядку способов; переплата уходит в аванс клиента
	precision = si.precision("outstanding_amount")
	outstanding = flt(si.outstanding_amount, precision)
	names = []
	for p in payments:
		allocated = flt(min(flt(p.amount), outstanding), precision)
		names.append(
			make_payment_entry(
				booking, si, p.mode_of_payment, p.amount, allocated, posting_date, p.reference_no
			)
		)
		outstanding = flt(outstanding - allocated, precision)
	return names


@frappe.whitelist()
def make_booking_payment(
	room_booking: str,
	mode_of_payment: str,
	amount: float,
	posting_date: str | None = None,
	reference_no: str | None = None,
):
	"""Создать и провести один Payment Entry (Приход) по счёту брони."""
	if flt(amount) <= 0:
		frappe.throw(_("Amount must be greater than zero"))

	payment = {"mode_of_payment": mode_of_payment, "amount": amount, "reference_no": reference_no}
	return make_booking_payments(room_booking, [payment], posting_date)[0]


def get_payable_invoice(room_booking):
	"""Бронь и её проведённый счёт с непогашенным остатком."""
	booking = frappe.get_doc("Room Booking", room_booking)
	booking.check_permission("read")

	if not booking.sales_invoice:
		frappe.throw(_("Create a Sales Invoice for this booking first"))

	si = frappe.get_doc("Sales Invoice", booking.sales_invoice)
	if si.docstatus != 1:
		frappe.throw(_("Sales Invoice {0} is not submitted").format(si.name))
	if flt(si.outstanding_amount) <= 0:
		frappe.throw(_("Sales Invoice {0} is already paid").format(si.name))

	return booking, si


def make_payment_entry(booking, si, mode_of_payment, amount, allocated, posting_date=None, reference_no=None):
	"""Провести Payment Entry на сумму amount, из которой allocated гасит счёт брони."""
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	amount = flt(amount)

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
		ref.allocated_amount = min(flt(allocated), flt(ref.outstanding_amount))
	# счёт уже погашен предыдущими платежами — этот платёж целиком аванс
	pe.set("references", [ref for ref in pe.references if flt(ref.allocated_amount) > 0])

	pe.set_exchange_rate()
	pe.set_amounts()
	# право на бронь и способ оплаты проверены выше — прав на Payment Entry не требуем,
	# как и на Sales Invoice при выставлении счёта (сотруднику отеля хватает брони)
	pe.flags.ignore_permissions = True
	pe.insert()
	pe.submit()
	return pe.name


# --- номера -------------------------------------------------------------------


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
		fields=["room_rate", "rate_per_day"],
		order_by="idx asc",
	)


@frappe.whitelist()
def active_room_query(doctype, txt, searchfield, start, page_len, filters):
	"""Поиск для полей-ссылок на номер: без отключённых номеров и номеров отключённых типов."""
	txt = f"%{txt or ''}%"
	return frappe.get_list(
		"Hotel Room",
		filters=active_room_filters(),
		or_filters=[["name", "like", txt], ["room_number", "like", txt]],
		fields=["name", "room_type", "hotel_building"],
		order_by="name asc",
		limit_start=cint(start),
		limit_page_length=cint(page_len) or 20,
		as_list=True,
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
					fields=["name", "icon", "description"],
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

	floor_label = (
		frappe.db.get_value("Hotel Floor", doc.hotel_floor, "floor_number") if doc.hotel_floor else None
	)

	return {
		"name": doc.name,
		"room_number": doc.room_number,
		"room_type": doc.room_type,
		"hotel_building": doc.hotel_building,
		"floor": floor_label,
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


# --- счёт ---------------------------------------------------------------------


@frappe.whitelist()
def make_sales_invoice_from_booking(room_booking: str):
	"""Создать и провести Sales Invoice по брони.

	Раньше это был Server Script «Room Booking Invoice» с API-методом
	make_sales_invoice_from_booking.
	"""
	booking = frappe.get_doc("Room Booking", room_booking)
	booking.check_permission("write")

	if not booking.customer:
		frappe.throw(_("Set Customer on the booking"))

	if not booking.hotel_profile:
		frappe.throw(_("Set Hotel Profile on the booking"))

	hotel_profile = frappe.get_doc("Hotel Profile", booking.hotel_profile)
	if not hotel_profile.default_service:
		frappe.throw(_("Default Service is not set in Hotel Profile"))

	cancel_previous_invoice(booking)

	si = frappe.new_doc("Sales Invoice")
	si.customer = booking.customer
	si.company = booking.company

	def add_item(item_code, qty, rate):
		si.append(
			"items",
			{
				"item_code": item_code,
				"qty": flt(qty),
				"rate": flt(rate),
				"warehouse": hotel_profile.warehouse,
			},
		)

	# проживание
	add_item(hotel_profile.default_service, 1, booking.amount)
	# дополнительные товары и услуги (мини-бар и прочее) — с наценкой
	for row in booking.items_and_service:
		add_item(row.item, row.qty, get_rate_with_markup(row))
	# процентные услуги (цена — процент от часового тарифа номера)
	for row in booking.percentage_services:
		add_item(row.item, row.qty, row.rate)

	si.insert(ignore_permissions=True)
	# счёт сразу проводим — по нему можно принимать оплату
	si.submit()

	frappe.db.set_value("Room Booking", booking.name, "sales_invoice", si.name)
	return si.name


def cancel_previous_invoice(booking):
	"""Отменить (или удалить черновик) предыдущий счёт брони перед созданием нового."""
	if not (booking.sales_invoice and frappe.db.exists("Sales Invoice", booking.sales_invoice)):
		return
	# счёт с оплатами отменить нельзя — иначе оплаты повиснут без счёта
	if invoice_has_payments(booking.sales_invoice):
		frappe.throw(
			_("Sales Invoice {0} already has payments and cannot be recreated").format(
				frappe.bold(booking.sales_invoice)
			)
		)

	old_name = booking.sales_invoice
	frappe.db.set_value("Room Booking", booking.name, "sales_invoice", None)
	cancel_sales_invoice(old_name)


def update_booking_payment_status(doc, method=None):
	"""Статус оплаты брони по остатку её счёта.

	Вызывается из doc_events на Payment Entry (проведение и отмена);
	раньше это были Server Scripts «Payment Entry After Submit/Cancel».
	"""
	for ref in doc.references:
		if ref.reference_doctype != "Sales Invoice":
			continue

		booking = frappe.db.get_value("Room Booking", {"sales_invoice": ref.reference_name}, "name")
		if not booking:
			continue

		outstanding = flt(frappe.db.get_value("Sales Invoice", ref.reference_name, "outstanding_amount"))
		frappe.db.set_value("Room Booking", booking, "pay_status", "Paid" if outstanding <= 0 else "Unpaid")
