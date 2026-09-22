# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class HotelProfile(Document):
	def validate(self):
		# фильтр поля отсекает группы в выборе, а здесь — при вводе/импорте вручную
		if self.income_account and frappe.db.get_value("Account", self.income_account, "is_group"):
			frappe.throw(
				_("Account {0} is a group account and cannot be selected").format(
					frappe.bold(self.income_account)
				)
			)
