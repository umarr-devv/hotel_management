# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class HotelProfile(Document):
	def validate(self):
		validate_unique(
			self.modes_of_payment, "mode_of_payment", _("Mode of Payment {0} is listed more than once")
		)
		validate_unique(self.employees, "user", _("User {0} is listed more than once"))


def validate_unique(rows, fieldname, message):
	seen = set()
	for row in rows:
		value = row.get(fieldname)
		if value in seen:
			frappe.throw(message.format(frappe.bold(value)))
		seen.add(value)


def get_table_values(hotel_profile, table, fieldname):
	"""Значения колонки таблицы профиля отеля — в порядке строк, без пустых."""
	if not hotel_profile:
		return []
	rows = frappe.get_cached_doc("Hotel Profile", hotel_profile).get(table)
	return [row.get(fieldname) for row in rows if row.get(fieldname)]


def get_employees(hotel_profile):
	"""Сотрудники (пользователи) профиля отеля."""
	return get_table_values(hotel_profile, "employees", "user")


def get_payment_modes(hotel_profile):
	"""Способы оплаты профиля отеля."""
	return get_table_values(hotel_profile, "modes_of_payment", "mode_of_payment")


def validate_payment_mode(hotel_profile, mode_of_payment):
	"""Способ оплаты должен быть в таблице профиля отеля."""
	if mode_of_payment not in get_payment_modes(hotel_profile):
		frappe.throw(
			_("Mode of Payment {0} is not allowed in Hotel Profile {1}").format(
				frappe.bold(mode_of_payment), frappe.bold(hotel_profile)
			)
		)


@frappe.whitelist()
def payment_mode_query(doctype, txt, searchfield, start, page_len, filters):
	"""Поиск для полей-ссылок на способ оплаты: включённые способы из таблицы профиля отеля."""
	modes = get_payment_modes((filters or {}).get("hotel_profile"))
	if not modes:
		return []

	txt = (txt or "").lower()
	enabled = set(
		frappe.get_all("Mode of Payment", filters={"name": ["in", modes], "enabled": 1}, pluck="name")
	)
	found = [(mode,) for mode in modes if mode in enabled and txt in mode.lower()]
	start = cint(start)
	return found[start : start + (cint(page_len) or 20)]


def get_payment_accounts(hotel_profile):
	"""Счета кассы/банка способов оплаты профиля (по всем компаниям) — в порядке таблицы."""
	modes = get_payment_modes(hotel_profile)
	if not modes:
		return []

	rows = frappe.get_all(
		"Mode of Payment Account",
		filters={"parenttype": "Mode of Payment", "parent": ["in", modes], "default_account": ["is", "set"]},
		fields=["parent", "default_account"],
		order_by="idx asc",
	)
	accounts = []
	for mode in modes:
		for row in rows:
			if row.parent == mode and row.default_account not in accounts:
				accounts.append(row.default_account)
	return accounts
