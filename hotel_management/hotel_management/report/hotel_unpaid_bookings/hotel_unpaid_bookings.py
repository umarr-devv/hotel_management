# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Неоплаченные брони: сколько денег отель ещё не получил и с кого.

Строка отчёта — плательщик брони, у которого остался долг:
  * счёт плательщику не выставлен (или устарел) — долг на сумму без оплаченного;
  * счёт выставлен и по нему есть остаток.

У общего счёта группы оплата делится между бронями пропорционально их суммам.
"""

import frappe
from frappe import _
from frappe.utils import date_diff, flt, getdate, nowdate

from hotel_management.billing import NOT_INVOICED
from hotel_management.hotel_management.report.report_utils import (
	get_bookings,
	get_payer_billing,
	get_period,
)


def execute(filters=None):
	filters = frappe._dict(filters or {})
	from_date, to_date = get_period(filters, default_days=90)

	bookings = get_bookings(filters, from_date, to_date)
	if filters.get("only_checked_out"):
		bookings = [booking for booking in bookings if booking.status in ("Checked Out", "Completed")]
	payer_billing = get_payer_billing(bookings)

	rows = []
	for booking in bookings:
		for state in payer_billing.get(booking.name, []):
			if flt(state.balance_due) > 0:
				rows.append(make_row(booking, state))

	rows.sort(key=lambda row: flt(row["balance_due"]), reverse=True)

	return get_columns(), rows, None, None, get_report_summary(rows)


def make_row(booking, state):
	return {
		"booking": booking.name,
		"status": booking.status,
		"customer": booking.customer,
		"payer": state.payer,
		"room": booking.room,
		"check_in": booking.check_in,
		"check_out": booking.check_out,
		"payer_amount": flt(state.amount),
		"sales_invoice": state.sales_invoice,
		"invoice_status": _(state.status),
		"not_invoiced": state.status == NOT_INVOICED,
		"invoiced_amount": flt(state.invoiced_amount),
		"paid_amount": flt(state.paid_amount),
		"balance_due": flt(state.balance_due),
		"pay_status": _(booking.pay_status),
		"days_since_check_out": max(date_diff(getdate(nowdate()), getdate(booking.check_out)), 0),
	}


def get_report_summary(rows):
	overdue = [row for row in rows if row["days_since_check_out"] > 0]
	return [
		{
			"label": _("Bookings with Balance"),
			"value": len({row["booking"] for row in rows}),
			"datatype": "Int",
		},
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
			"value": sum(flt(row["balance_due"]) for row in rows if row["not_invoiced"]),
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
			"width": 160,
		},
		{
			"fieldname": "payer",
			"label": _("Payer"),
			"fieldtype": "Link",
			"options": "Customer",
			"width": 160,
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
			"fieldname": "payer_amount",
			"label": _("Payer Amount"),
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
		{"fieldname": "pay_status", "label": _("Payment"), "fieldtype": "Data", "width": 120},
		{
			"fieldname": "days_since_check_out",
			"label": _("Days Since Check Out"),
			"fieldtype": "Int",
			"width": 160,
		},
	]
