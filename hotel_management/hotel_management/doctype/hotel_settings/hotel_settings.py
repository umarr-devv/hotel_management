# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class HotelSettings(Document):
	def validate(self):
		seen = set()
		for row in self.modes_of_payment:
			if row.mode_of_payment in seen:
				frappe.throw(
					_("Mode of Payment {0} is listed more than once").format(frappe.bold(row.mode_of_payment))
				)
			seen.add(row.mode_of_payment)


def get_payment_modes():
	"""Способы оплаты из настроек отеля — в порядке таблицы."""
	return [
		row.mode_of_payment
		for row in frappe.get_cached_doc("Hotel Settings").modes_of_payment
		if row.mode_of_payment
	]
