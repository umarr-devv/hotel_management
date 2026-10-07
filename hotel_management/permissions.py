# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Права ролей отеля.

Карта прав — источник правды для двух ролей приложения:
  * Hotel Manager — всё в модуле Hotel Management и связанные документы ERPNext;
  * Hotel Employee — бронирования и расходы, справочники отеля только на просмотр,
    связанные документы — сколько нужно, чтобы создавать брони и расходы.

Права на DocType модуля лежат в их JSON (те же строки, что в MODULE_PERMISSIONS), но
если на сайте права DocType уже меняли в Role Permission Manager (есть Custom DocPerm),
Frappe JSON не читает. Поэтому после миграции sync_role_permissions выдаёт права из карты
через Custom DocPerm: для связанных DocType ERPNext всегда, для DocType модуля — если у
них есть Custom DocPerm. Права только добавляются: то, что выдано вручную, не снимается.
"""

import frappe

HOTEL_MANAGER = "Hotel Manager"
HOTEL_EMPLOYEE = "Hotel Employee"

READ = ("read",)
READ_REPORT = ("read", "report")
WRITE = ("read", "write", "create", "report", "print", "email")
SUBMIT = (*WRITE, "submit", "cancel", "amend")
FULL = (*WRITE, "delete", "export", "share")
FULL_SUBMIT = (*FULL, "submit", "cancel", "amend")

# DocType модуля: {doctype: {роль: права}}
MODULE_PERMISSIONS = {
	"Room Booking": {HOTEL_MANAGER: FULL_SUBMIT, HOTEL_EMPLOYEE: SUBMIT},
	"Hotel Expense": {HOTEL_MANAGER: FULL_SUBMIT, HOTEL_EMPLOYEE: SUBMIT},
	"Hotel Room": {HOTEL_MANAGER: FULL, HOTEL_EMPLOYEE: READ_REPORT},
	"Room Type": {HOTEL_MANAGER: FULL, HOTEL_EMPLOYEE: READ_REPORT},
	"Hotel Floor": {HOTEL_MANAGER: FULL, HOTEL_EMPLOYEE: READ_REPORT},
	"Hotel Building": {HOTEL_MANAGER: FULL, HOTEL_EMPLOYEE: READ_REPORT},
	"Room Rate": {HOTEL_MANAGER: FULL, HOTEL_EMPLOYEE: READ_REPORT},
	"Room Amenity": {HOTEL_MANAGER: FULL, HOTEL_EMPLOYEE: READ_REPORT},
	"Hotel Profile": {HOTEL_MANAGER: FULL, HOTEL_EMPLOYEE: READ_REPORT},
}

# связанные DocType ERPNext — то, что открывается и создаётся из броней и расходов
_RELATED = {
	# гость брони и его контакты
	"Customer": WRITE,
	"Contact": WRITE,
	"Address": WRITE,
	"Customer Group": READ,
	"Territory": READ,
	# поставщик расхода
	"Supplier": WRITE,
	"Supplier Group": READ,
	# товары и услуги брони и расхода
	"Item": READ,
	"Item Price": READ,
	"Price List": READ,
	"UOM": READ,
	# оплата и документы, которые создаются из броней и расходов
	"Company": READ,
	"Mode of Payment": READ,
	"Sales Invoice": READ_REPORT,
	"Payment Entry": READ_REPORT,
	"Purchase Invoice": READ_REPORT,
}
RELATED_PERMISSIONS = {
	doctype: {HOTEL_MANAGER: perms, HOTEL_EMPLOYEE: perms} for doctype, perms in _RELATED.items()
}


def sync_role_permissions():
	"""Выдать права из карты через Custom DocPerm (см. описание модуля)."""
	for doctype, roles in RELATED_PERMISSIONS.items():
		grant(doctype, roles)

	for doctype, roles in MODULE_PERMISSIONS.items():
		# без Custom DocPerm Frappe читает права из JSON DocType — там они уже есть
		if frappe.db.exists("Custom DocPerm", {"parent": doctype}):
			grant(doctype, roles)

	frappe.clear_cache()


def grant(doctype, roles):
	"""Добавить ролям права на DocType (permlevel 0), не снимая уже выданные."""
	from frappe.permissions import setup_custom_perms

	if not frappe.db.exists("DocType", doctype):
		return

	# первая своя строка прав отключает стандартные — сначала копируем их в Custom DocPerm
	setup_custom_perms(doctype)

	for role, ptypes in roles.items():
		if not frappe.db.exists("Role", role):
			continue
		perm = get_custom_docperm(doctype, role)
		missing = [ptype for ptype in ptypes if not perm.get(ptype)]
		if missing or perm.is_new():
			perm.update(dict.fromkeys(missing, 1))
			perm.save(ignore_permissions=True)


def get_custom_docperm(doctype, role):
	"""Строка Custom DocPerm роли (permlevel 0, не «только свои»); новая, если её нет."""
	name = frappe.db.get_value(
		"Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0, "if_owner": 0}
	)
	if name:
		return frappe.get_doc("Custom DocPerm", name)
	return frappe.get_doc(
		{
			"doctype": "Custom DocPerm",
			"parent": doctype,
			"parenttype": "DocType",
			"parentfield": "permissions",
			"role": role,
			"permlevel": 0,
		}
	)
