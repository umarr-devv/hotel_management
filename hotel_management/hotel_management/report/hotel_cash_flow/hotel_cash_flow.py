# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Движение денег отеля: что пришло и ушло через кассы/банки профиля отеля за период.

Счета профиля — счета по умолчанию способов оплаты из таблицы Hotel Profile (по всем
компаниям). Правила:
  * приход — проведённый Payment Entry, у которого paid_to — счёт профиля;
  * расход — проведённый Payment Entry, у которого paid_from — счёт профиля, и
    проведённый оплаченный Purchase Invoice (is_paid), у которого cash_bank_account —
    счёт профиля. Internal Transfer между счетами профиля даёт и расход, и приход;
  * дата и время Payment Entry — дата проводки + время создания документа (своего
    времени у Payment Entry нет), Purchase Invoice — posting_date + posting_time;
  * остаток на конец — баланс счёта по GL на конец периода по всем проводкам, в том
    числе по документам, которых нет в отчёте (например, Journal Entry).
"""

import frappe
from frappe import _
from frappe.utils import add_to_date, flt, get_datetime, get_fullname

from hotel_management.hotel_management.doctype.hotel_profile.hotel_profile import get_payment_accounts

# сколько позиций закупки перечислять в колонке «На что расход»
MAX_ITEMS_IN_PURPOSE = 5

PE_DATETIME = "timestamp(pe.posting_date, time(pe.creation))"
PI_DATETIME = "timestamp(pi.posting_date, ifnull(pi.posting_time, '00:00:00'))"


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if not filters.hotel_profile:
		return get_columns(), []
	frappe.has_permission("Hotel Profile", "read", filters.hotel_profile, throw=True)

	start, end = get_period(filters)
	accounts = get_accounts(filters.hotel_profile)
	if not accounts:
		frappe.msgprint(
			_("Hotel Profile {0} has no Modes of Payment with default accounts").format(
				frappe.bold(filters.hotel_profile)
			)
		)
		return get_columns(), []

	income = get_income(accounts, start, end)
	expenses = get_pe_expenses(accounts, start, end) + get_pi_expenses(accounts, start, end)
	expenses.sort(key=lambda row: (row["posting_datetime"], row["voucher_no"]))
	balances = get_balances(accounts, end)

	set_employee_names(income + expenses)

	data = []
	add_section(data, _("Payments"), income)
	add_section(data, _("Expenses"), expenses)
	add_section(data, _("Balance at End"), balances)

	return get_columns(), data, None, None, get_report_summary(income, expenses, balances)


def get_period(filters):
	"""Границы периода [start, end): «до» включает всю указанную секунду."""
	if not filters.from_datetime or not filters.to_datetime:
		frappe.throw(_("Set From Date and To Date"))
	start = get_datetime(filters.from_datetime)
	end = get_datetime(filters.to_datetime)
	if start > end:
		frappe.throw(_("From Date must be before To Date"))
	return start, add_to_date(end, seconds=1)


def period_values(accounts, start, end):
	return {
		"accounts": tuple(accounts),
		"start": start,
		"end": end,
		"start_date": start.date(),
		"end_date": end.date(),
	}


def get_accounts(hotel_profile):
	"""Счета профиля с валютой счёта и валютой компании."""
	names = get_payment_accounts(hotel_profile)
	if not names:
		return {}

	info = {
		account.name: account
		for account in frappe.get_all(
			"Account", filters={"name": ["in", names]}, fields=["name", "account_currency", "company"]
		)
	}
	accounts = {}
	for name in names:
		account = info.get(name)
		if not account:
			continue
		account.company_currency = frappe.get_cached_value("Company", account.company, "default_currency")
		account.currency = account.account_currency or account.company_currency
		accounts[name] = account
	return accounts


def get_payment_entries(accounts, start, end, account_field):
	"""Проведённые Payment Entry периода, у которых account_field (paid_to / paid_from) — счёт профиля."""
	return frappe.db.sql(
		f"""
		select pe.name, pe.payment_type, pe.party_type, pe.party, pe.party_name, pe.paid_from,
			pe.paid_to, pe.paid_amount, pe.received_amount, pe.reference_no, pe.remarks,
			pe.custom_remarks, pe.owner, {PE_DATETIME} as posting_datetime
		from `tabPayment Entry` pe
		where pe.docstatus = 1 and pe.{account_field} in %(accounts)s
			and pe.posting_date between %(start_date)s and %(end_date)s
			and {PE_DATETIME} >= %(start)s and {PE_DATETIME} < %(end)s
		order by posting_datetime asc, pe.name asc
		""",
		period_values(accounts, start, end),
		as_dict=True,
	)


def payment_note(pe):
	"""Примечание платежа: только введённое вручную — автоматическое повторяет колонки отчёта."""
	return pe.remarks if pe.custom_remarks else ""


def get_income(accounts, start, end):
	entries = get_payment_entries(accounts, start, end, "paid_to")
	bookings = get_payment_bookings(entries)

	rows = []
	for pe in entries:
		if pe.payment_type == "Internal Transfer":
			note = _("Transfer from {0}").format(pe.paid_from)
		else:
			note = payment_note(pe)
		rows.append(
			make_row(
				accounts[pe.paid_to],
				pe.received_amount,
				pe,
				"Payment Entry",
				customer=pe.party if pe.party_type == "Customer" else None,
				room_booking=bookings.get(pe.name),
				note=note,
			)
		)
	return rows


def get_payment_bookings(entries):
	"""Бронь, за которую платили: по счёту брони в разбивке платежа, иначе по reference_no.

	Аванс без разбивки (переплата) находится по reference_no — при оплате из
	шахматки туда пишется номер брони, если номер документа не указан.
	"""
	if not entries:
		return {}

	references = frappe.get_all(
		"Payment Entry Reference",
		filters={
			"parenttype": "Payment Entry",
			"parent": ["in", [pe.name for pe in entries]],
			"reference_doctype": "Sales Invoice",
		},
		fields=["parent", "reference_name"],
		order_by="idx asc",
	)
	invoices = list({ref.reference_name for ref in references})
	booking_by_invoice = {}
	if invoices:
		booking_by_invoice = dict(
			frappe.get_all(
				"Room Booking",
				filters={"sales_invoice": ["in", invoices], "docstatus": ["<", 2]},
				fields=["sales_invoice", "name"],
				as_list=True,
			)
		)

	bookings = {}
	for ref in references:
		booking = booking_by_invoice.get(ref.reference_name)
		if booking:
			bookings.setdefault(ref.parent, booking)

	reference_nos = {pe.reference_no for pe in entries if pe.name not in bookings and pe.reference_no}
	if reference_nos:
		existing = set(
			frappe.get_all("Room Booking", filters={"name": ["in", list(reference_nos)]}, pluck="name")
		)
		for pe in entries:
			if pe.name not in bookings and pe.reference_no in existing:
				bookings[pe.name] = pe.reference_no
	return bookings


def get_pe_expenses(accounts, start, end):
	entries = get_payment_entries(accounts, start, end, "paid_from")

	rows = []
	for pe in entries:
		if pe.payment_type == "Internal Transfer":
			purpose = _("Transfer to {0}").format(pe.paid_to)
		else:
			purpose = pe.party_name or pe.party or pe.paid_to
		rows.append(
			make_row(
				accounts[pe.paid_from],
				pe.paid_amount,
				pe,
				"Payment Entry",
				purpose=purpose,
				note=payment_note(pe),
			)
		)
	return rows


def get_pi_expenses(accounts, start, end):
	invoices = frappe.db.sql(
		f"""
		select pi.name, pi.supplier, pi.supplier_name, pi.cash_bank_account, pi.paid_amount,
			pi.base_paid_amount, pi.remarks, pi.owner,
			{PI_DATETIME} as posting_datetime
		from `tabPurchase Invoice` pi
		where pi.docstatus = 1 and pi.is_paid = 1 and pi.cash_bank_account in %(accounts)s
			and pi.posting_date between %(start_date)s and %(end_date)s
			and {PI_DATETIME} >= %(start)s and {PI_DATETIME} < %(end)s
		""",
		period_values(accounts, start, end),
		as_dict=True,
	)
	items = get_invoice_items([pi.name for pi in invoices])

	no_remarks = {"No Remarks", _("No Remarks")}
	rows = []
	for pi in invoices:
		account = accounts[pi.cash_bank_account]
		# в валюте счёта: base_paid_amount — в валюте компании, paid_amount — в валюте документа
		amount = pi.base_paid_amount if account.currency == account.company_currency else pi.paid_amount
		purpose = pi.supplier_name or pi.supplier
		if items.get(pi.name):
			purpose = f"{purpose}: {items[pi.name]}"
		rows.append(
			make_row(
				account,
				amount,
				pi,
				"Purchase Invoice",
				purpose=purpose,
				note="" if pi.remarks in no_remarks else pi.remarks,
			)
		)
	return rows


def get_invoice_items(names):
	"""Наименования позиций закупки через запятую."""
	if not names:
		return {}

	by_invoice = {}
	for item in frappe.get_all(
		"Purchase Invoice Item",
		filters={"parenttype": "Purchase Invoice", "parent": ["in", names]},
		fields=["parent", "item_name", "item_code"],
		order_by="idx asc",
	):
		item_names = by_invoice.setdefault(item.parent, [])
		name = item.item_name or item.item_code
		if name not in item_names:
			item_names.append(name)

	result = {}
	for parent, item_names in by_invoice.items():
		text = ", ".join(item_names[:MAX_ITEMS_IN_PURPOSE])
		if len(item_names) > MAX_ITEMS_IN_PURPOSE:
			text += " " + _("and {0} more").format(len(item_names) - MAX_ITEMS_IN_PURPOSE)
		result[parent] = text
	return result


def get_balances(accounts, end):
	"""Остаток каждого счёта по GL на конец периода (в валюте счёта).

	Время проводки — как у документов в отчёте; для прочих документов — время
	создания проводки.
	"""
	balances = dict(
		frappe.db.sql(
			f"""
			select gle.account, sum(gle.debit_in_account_currency - gle.credit_in_account_currency)
			from `tabGL Entry` gle
			left join `tabPayment Entry` pe
				on gle.voucher_type = 'Payment Entry' and pe.name = gle.voucher_no
			left join `tabPurchase Invoice` pi
				on gle.voucher_type = 'Purchase Invoice' and pi.name = gle.voucher_no
			where gle.is_cancelled = 0 and gle.account in %(accounts)s
				and gle.posting_date <= %(end_date)s
				and coalesce({PI_DATETIME}, {PE_DATETIME},
					timestamp(gle.posting_date, time(gle.creation))) < %(end)s
			group by gle.account
			""",
			{"accounts": tuple(accounts), "end": end, "end_date": end.date()},
		)
	)
	return [
		{"account": name, "amount": flt(balances.get(name)), "currency": account.currency, "indent": 1}
		for name, account in accounts.items()
	]


def make_row(account, amount, doc, voucher_type, customer=None, room_booking=None, purpose=None, note=None):
	return {
		"account": account.name,
		"amount": flt(amount),
		"currency": account.currency,
		"customer": customer,
		"room_booking": room_booking,
		"purpose": purpose,
		"note": note,
		"owner": doc.owner,
		"posting_datetime": doc.posting_datetime,
		"voucher_type": voucher_type,
		"voucher_no": doc.name,
		"indent": 1,
	}


def set_employee_names(rows):
	names = {}
	for row in rows:
		if row["owner"] not in names:
			names[row["owner"]] = get_fullname(row["owner"])
		row["employee"] = names[row["owner"]]


def add_section(data, label, rows):
	"""Строка-заголовок раздела с итогом (если валюта одна) и строки раздела под ней."""
	currencies = {row["currency"] for row in rows}
	header = {"account": label, "is_section": 1, "indent": 0}
	if len(currencies) == 1:
		header.update(amount=sum(flt(row["amount"]) for row in rows), currency=currencies.pop())
	data.append(header)
	data.extend(rows)


def get_report_summary(income, expenses, balances):
	if len({row["currency"] for row in income + expenses + balances}) > 1:
		return []

	total_income = sum(flt(row["amount"]) for row in income)
	total_expense = sum(flt(row["amount"]) for row in expenses)
	return [
		{"label": _("Payments"), "value": total_income, "datatype": "Currency", "indicator": "Green"},
		{"label": _("Expenses"), "value": total_expense, "datatype": "Currency", "indicator": "Red"},
		{
			"label": _("Net Cash Flow"),
			"value": total_income - total_expense,
			"datatype": "Currency",
			"indicator": "Green" if total_income >= total_expense else "Red",
		},
		{
			"label": _("Balance at End"),
			"value": sum(flt(row["amount"]) for row in balances),
			"datatype": "Currency",
			"indicator": "Blue",
		},
	]


def get_columns():
	return [
		{
			"fieldname": "account",
			"label": _("Account"),
			"fieldtype": "Link",
			"options": "Account",
			"width": 220,
		},
		{
			"fieldname": "amount",
			"label": _("Amount"),
			"fieldtype": "Currency",
			"options": "currency",
			"width": 140,
		},
		{
			"fieldname": "customer",
			"label": _("Customer"),
			"fieldtype": "Link",
			"options": "Customer",
			"width": 170,
		},
		{
			"fieldname": "room_booking",
			"label": _("Booking"),
			"fieldtype": "Link",
			"options": "Room Booking",
			"width": 150,
		},
		{"fieldname": "purpose", "label": _("Expense For"), "fieldtype": "Data", "width": 220},
		{"fieldname": "note", "label": _("Note"), "fieldtype": "Data", "width": 200},
		{"fieldname": "employee", "label": _("Employee"), "fieldtype": "Data", "width": 150},
		{
			"fieldname": "posting_datetime",
			"label": _("Date and Time"),
			"fieldtype": "Datetime",
			"width": 160,
		},
		{
			"fieldname": "voucher_type",
			"label": _("Voucher Type"),
			"fieldtype": "Link",
			"options": "DocType",
			"width": 140,
		},
		{
			"fieldname": "voucher_no",
			"label": _("Voucher No"),
			"fieldtype": "Dynamic Link",
			"options": "voucher_type",
			"width": 170,
		},
		{
			"fieldname": "currency",
			"label": _("Currency"),
			"fieldtype": "Link",
			"options": "Currency",
			"hidden": 1,
		},
	]
