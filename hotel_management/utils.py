# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Общие помощники приложения."""

import frappe
from frappe.utils import flt


def get_disabled_room_types():
	"""Имена отключённых типов номеров."""
	return frappe.get_all("Room Type", filters={"disabled": 1}, pluck="name")


def active_room_filters():
	"""Фильтры Hotel Room: только включённые номера включённых типов."""
	filters = [["disabled", "=", 0]]
	disabled_types = get_disabled_room_types()
	if disabled_types:
		filters.append(["room_type", "not in", disabled_types])
	return filters


def is_room_active(room):
	"""Номер включён, и его тип номера тоже включён."""
	values = frappe.db.get_value("Hotel Room", room, ["disabled", "room_type"], as_dict=True)
	if not values or values.disabled:
		return False
	return not (values.room_type and frappe.db.get_value("Room Type", values.room_type, "disabled"))


def invoice_has_payments(sales_invoice):
	"""По проведённому счёту уже что-то оплачено (полностью или частично)."""
	if not sales_invoice:
		return False
	si = frappe.db.get_value(
		"Sales Invoice",
		sales_invoice,
		["docstatus", "grand_total", "rounded_total", "outstanding_amount"],
		as_dict=True,
	)
	if not si or si.docstatus != 1:
		return False
	# при включённом округлении остаток считается от округлённой суммы
	total = flt(si.rounded_total) or flt(si.grand_total)
	precision = frappe.get_precision("Sales Invoice", "outstanding_amount")
	return flt(si.outstanding_amount, precision) < flt(total, precision)
