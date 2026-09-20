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
