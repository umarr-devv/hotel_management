# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Передача денег из кассы профиля отеля в кассу передачи (обычно — кассу менеджера).

Сотрудник создаёт передачу и отправляет её на утверждение (workflow «Hotel Money Transfer»),
менеджер утверждает — документ проводится, и деньги переводятся проводкой Journal Entry
(Contra Entry): дебет кассы получателя, кредит кассы отправителя. При отмене передачи
проводка тоже отменяется.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt

from hotel_management.hotel_management.doctype.hotel_profile.hotel_profile import get_payment_accounts

CASH_ACCOUNT_TYPES = ("Cash", "Bank")


class HotelMoneyTransfer(Document):
	def validate(self):
		if flt(self.amount) <= 0:
			frappe.throw(_("Amount must be greater than zero"))
		self.validate_accounts()

	def validate_accounts(self):
		# validate идёт раньше проверки обязательных полей — пустые счета она отловит сама
		if not (self.from_account and self.to_account):
			return
		if self.from_account not in get_payment_accounts(self.hotel_profile):
			frappe.throw(
				_("Account {0} is not a cash desk of Hotel Profile {1}").format(
					frappe.bold(self.from_account), frappe.bold(self.hotel_profile)
				)
			)
		if self.from_account == self.to_account:
			frappe.throw(_("From Account and To Account must be different"))

		self.company = frappe.get_cached_value("Account", self.from_account, "company")
		self.currency = frappe.get_cached_value("Company", self.company, "default_currency")

		to_account = frappe.get_cached_value(
			"Account", self.to_account, ["company", "is_group", "account_type"], as_dict=True
		)
		if to_account.company != self.company:
			frappe.throw(
				_("Account {0} does not belong to Company {1}").format(
					frappe.bold(self.to_account), frappe.bold(self.company)
				)
			)
		if to_account.is_group or to_account.account_type not in CASH_ACCOUNT_TYPES:
			frappe.throw(_("Account {0} is not a cash or bank account").format(frappe.bold(self.to_account)))

	def on_submit(self):
		self.db_set("journal_entry", make_journal_entry(self))

	def on_cancel(self):
		if not (self.journal_entry and frappe.db.exists("Journal Entry", self.journal_entry)):
			return
		je = frappe.get_doc("Journal Entry", self.journal_entry)
		if je.docstatus == 1:
			je.flags.ignore_permissions = True
			je.cancel()


def make_journal_entry(transfer):
	"""Создать и провести Journal Entry: деньги из кассы отправителя в кассу получателя."""
	je = frappe.new_doc("Journal Entry")
	je.voucher_type = "Contra Entry"
	je.company = transfer.company
	je.posting_date = transfer.posting_date
	je.user_remark = transfer.notes or _("Hotel Money Transfer {0}").format(transfer.name)
	je.append("accounts", {"account": transfer.to_account, "debit_in_account_currency": flt(transfer.amount)})
	je.append(
		"accounts", {"account": transfer.from_account, "credit_in_account_currency": flt(transfer.amount)}
	)

	# проводку делает тот, кто утверждает передачу, даже без прав на Journal Entry
	je.flags.ignore_permissions = True
	je.insert()
	je.submit()
	return je.name


@frappe.whitelist()
def get_profile_accounts(hotel_profile):
	"""Кассы профиля (откуда передавать) и касса передачи (куда) — для формы передачи."""
	frappe.has_permission("Hotel Profile", "read", hotel_profile, throw=True)
	return {
		"from_accounts": get_payment_accounts(hotel_profile),
		"transfer_account": frappe.db.get_value("Hotel Profile", hotel_profile, "transfer_account"),
	}


@frappe.whitelist()
def from_account_query(doctype, txt, searchfield, start, page_len, filters):
	"""Поиск кассы отправителя: только счета способов оплаты профиля отеля."""
	txt = (txt or "").lower()
	accounts = get_payment_accounts((filters or {}).get("hotel_profile"))
	found = [(account,) for account in accounts if txt in account.lower()]
	start = cint(start)
	return found[start : start + (cint(page_len) or 20)]


@frappe.whitelist()
def to_account_query(doctype, txt, searchfield, start, page_len, filters):
	"""Поиск кассы получателя: счета кассы/банка компании кассы отправителя."""
	filters = filters or {}
	conditions = {"is_group": 0, "disabled": 0, "account_type": ["in", CASH_ACCOUNT_TYPES]}
	if filters.get("from_account"):
		conditions["company"] = frappe.db.get_value("Account", filters["from_account"], "company")
		conditions["name"] = ["!=", filters["from_account"]]
	return frappe.get_all(
		"Account",
		filters=conditions,
		or_filters={"name": ["like", f"%{txt}%"], "account_name": ["like", f"%{txt}%"]},
		fields=["name", "account_name"],
		order_by="name asc",
		start=cint(start),
		page_length=cint(page_len) or 20,
		as_list=True,
	)
