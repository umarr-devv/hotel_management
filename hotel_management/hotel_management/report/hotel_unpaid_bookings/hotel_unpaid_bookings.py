# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Неоплаченные брони: сколько денег отель ещё не получил.

В отчёт попадают брони, по которым остался долг:
  * счёт не выставлен, а бронь не помечена как оплаченная, либо
  * счёт выставлен и по нему есть остаток (outstanding_amount > 0).
"""

import frappe
from frappe import _
from frappe.utils import date_diff, flt, getdate, nowdate

from hotel_management.hotel_management.report.report_utils import get_bookings, get_period

NOT_INVOICED = "Not Invoiced"


def execute(filters=None):
	filters = frappe._dict(filters or {})
	from_date, to_date = get_period(filters, default_days=90)

	bookings = get_bookings(filters, from_date, to_date)
	invoices = get_invoices(bookings)

	rows = []
	for booking in bookings:
		invoice = invoices.get(booking.sales_invoice)
		row = make_row(booking, invoice)
		if flt(row["balance_due"]) <= 0:
			continue
		if filters.get("only_checked_out") and booking.status not in ("Checked Out", "Completed"):
			continue
		rows.append(row)

	rows.sort(key=lambda row: flt(row["balance_due"]), reverse=True)

	return get_columns(), rows, None, None, get_report_summary(rows)


def get_invoices(bookings):
	names = [booking.sales_invoice for booking in bookings if booking.sales_invoice]
	if not names:
		return {}

	invoices = frappe.get_all(
		"Sales Invoice",
		filters={"name": ("in", names), "docstatus": ("<", 2)},
		fields=["name", "status", "docstatus", "grand_total", "outstanding_amount"],
	)
	return {invoice.name: invoice for invoice in invoices}


def make_row(booking, invoice):
	invoiced = flt(invoice.grand_total) if invoice else 0.0
	outstanding = flt(invoice.outstanding_amount) if invoice else 0.0

	if invoice:
		# черновик счёта ещё ничего не требует — долгом считаем всю сумму брони
		balance_due = outstanding if invoice.docstatus == 1 else flt(booking.total_amount)
		invoice_status = invoice.status
	else:
		balance_due = 0.0 if booking.pay_status == "Paid" else flt(booking.total_amount)
		invoice_status = NOT_INVOICED

	return {
		"booking": booking.name,
		"status": booking.status,
		"customer": booking.customer,
		"room": booking.room,
		"check_in": booking.check_in,
		"check_out": booking.check_out,
		"total_amount": flt(booking.total_amount),
		"sales_invoice": booking.sales_invoice,
		"invoice_status": invoice_status,
		"invoiced_amount": invoiced,
		"paid_amount": flt(invoiced - outstanding) if invoice and invoice.docstatus == 1 else 0.0,
		"balance_due": flt(balance_due),
		"pay_status": booking.pay_status,
		"days_since_check_out": max(date_diff(getdate(nowdate()), getdate(booking.check_out)), 0),
	}


def get_report_summary(rows):
	overdue = [row for row in rows if row["days_since_check_out"] > 0]
	return [
		{"label": _("Bookings with Balance"), "value": len(rows), "datatype": "Int"},
		{
			"label": _("Balance Due"),
			"value": sum(flt(row["balance_due"]) for row in rows),
			"datatype": "Currency",
			"indicator": "Red" if rows else "Green",
		},
		{
			"label": _("Due After Check Out"),
			"value": sum(flt(row["balance_due"]) for row in overdue),
			"datatype": "Currency",
			"indicator": "Orange",
		},
		{
			"label": _("Not Invoiced"),
			"value": sum(flt(row["balance_due"]) for row in rows if row["invoice_status"] == NOT_INVOICED),
			"datatype": "Currency",
		},
	]


def get_columns():
	return [
		{
			"fieldname": "booking",
			"label": _("Booking"),
			"fieldtype": "Link",
			"options": "Room Booking",
			"width": 160,
		},
		{"fieldname": "status", "label": _("Status"), "fieldtype": "Data", "width": 110},
		{
			"fieldname": "customer",
			"label": _("Customer"),
			"fieldtype": "Link",
			"options": "Customer",
			"width": 180,
		},
		{
			"fieldname": "room",
			"label": _("Room"),
			"fieldtype": "Link",
			"options": "Hotel Room",
			"width": 140,
		},
		{"fieldname": "check_in", "label": _("Check In"), "fieldtype": "Datetime", "width": 160},
		{"fieldname": "check_out", "label": _("Check Out"), "fieldtype": "Datetime", "width": 160},
		{
			"fieldname": "total_amount",
			"label": _("Booking Amount"),
			"fieldtype": "Currency",
			"width": 140,
		},
		{
			"fieldname": "sales_invoice",
			"label": _("Sales Invoice"),
			"fieldtype": "Link",
			"options": "Sales Invoice",
			"width": 160,
		},
		{
			"fieldname": "invoice_status",
			"label": _("Invoice Status"),
			"fieldtype": "Data",
			"width": 130,
		},
		{
			"fieldname": "invoiced_amount",
			"label": _("Invoiced"),
			"fieldtype": "Currency",
			"width": 130,
		},
		{"fieldname": "paid_amount", "label": _("Paid"), "fieldtype": "Currency", "width": 130},
		{
			"fieldname": "balance_due",
			"label": _("Balance Due"),
			"fieldtype": "Currency",
			"width": 140,
		},
		{"fieldname": "pay_status", "label": _("Payment"), "fieldtype": "Data", "width": 100},
		{
			"fieldname": "days_since_check_out",
			"label": _("Days Since Check Out"),
			"fieldtype": "Int",
			"width": 160,
		},
	]
