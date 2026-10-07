# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class HotelProfile(Document):
	def validate(self):
		seen = set()
		for row in self.modes_of_payment:
			if row.mode_of_payment in seen:
				frappe.throw(
					_("Mode of Payment {0} is listed more than once").format(frappe.bold(row.mode_of_payment))
				)
			seen.add(row.mode_of_payment)


def get_payment_modes(hotel_profile):
	"""Способы оплаты профиля отеля — в порядке таблицы."""
	if not hotel_profile:
		return []
	return [
		row.mode_of_payment
		for row in frappe.get_cached_doc("Hotel Profile", hotel_profile).modes_of_payment
		if row.mode_of_payment
	]


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
