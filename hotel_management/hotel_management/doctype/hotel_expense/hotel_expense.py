# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Расход отеля: закупка товаров за наличные/безнал одним документом.

При проведении создаётся и проводится Purchase Invoice: уже оплаченный (is_paid) через
способ оплаты расхода и с обновлением запасов (update_stock) на склад профиля отеля.
При отмене расхода закупка тоже отменяется.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt

from hotel_management.hotel_management.doctype.hotel_profile.hotel_profile import get_payment_modes


class HotelExpense(Document):
	def validate(self):
		self.validate_items()
		self.validate_mode_of_payment()

	def validate_items(self):
		if not self.items:
			frappe.throw(_("Add at least one item"))

		total = 0.0
		for row in self.items:
			if flt(row.qty) <= 0:
				frappe.throw(_("Row {0}: Qty must be greater than zero").format(row.idx))
			if flt(row.rate) <= 0:
				frappe.throw(_("Row {0}: Rate must be greater than zero").format(row.idx))
			row.amount = flt(flt(row.qty) * flt(row.rate), row.precision("amount"))
			total += row.amount
		self.total_amount = flt(total, self.precision("total_amount"))

	def validate_mode_of_payment(self):
		if self.mode_of_payment not in get_payment_modes(self.hotel_profile):
			frappe.throw(
				_("Mode of Payment {0} is not allowed in Hotel Profile {1}").format(
					frappe.bold(self.mode_of_payment), frappe.bold(self.hotel_profile)
				)
			)
		# касса/банк должны быть настроены для компании — иначе закупку не провести
		get_cash_bank_account(self.mode_of_payment, self.company)

	def on_submit(self):
		self.db_set("purchase_invoice", make_purchase_invoice(self))

	def on_cancel(self):
		if not (self.purchase_invoice and frappe.db.exists("Purchase Invoice", self.purchase_invoice)):
			return
		pi = frappe.get_doc("Purchase Invoice", self.purchase_invoice)
		if pi.docstatus == 1:
			pi.flags.ignore_permissions = True
			pi.cancel()


def get_cash_bank_account(mode_of_payment, company):
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	return get_bank_cash_account(mode_of_payment, company)["account"]


def make_purchase_invoice(expense):
	"""Создать и провести оплаченный Purchase Invoice с обновлением запасов."""
	warehouse = frappe.db.get_value("Hotel Profile", expense.hotel_profile, "warehouse")
	if not warehouse:
		frappe.throw(_("Set Warehouse in Hotel Profile {0}").format(frappe.bold(expense.hotel_profile)))

	pi = frappe.new_doc("Purchase Invoice")
	pi.supplier = expense.supplier
	pi.company = expense.company
	pi.update_stock = 1
	pi.set_warehouse = warehouse
	pi.is_paid = 1
	pi.mode_of_payment = expense.mode_of_payment
	pi.cash_bank_account = get_cash_bank_account(expense.mode_of_payment, expense.company)
	pi.remarks = expense.notes or _("Hotel Expense {0}").format(expense.name)
	for row in expense.items:
		pi.append(
			"items",
			{"item_code": row.item, "qty": flt(row.qty), "rate": flt(row.rate), "warehouse": warehouse},
		)

	pi.run_method("set_missing_values")
	pi.run_method("calculate_taxes_and_totals")
	# оплачено полностью: на сервере ERPNext paid_amount закупки сам не считает
	pi.paid_amount = flt(pi.rounded_total or pi.grand_total, pi.precision("paid_amount"))
	pi.base_paid_amount = flt(pi.paid_amount * flt(pi.conversion_rate or 1), pi.precision("base_paid_amount"))

	# закупку проводит тот, кто проводит расход, даже без прав на Purchase Invoice
	pi.flags.ignore_permissions = True
	pi.insert()
	pi.submit()
	return pi.name
