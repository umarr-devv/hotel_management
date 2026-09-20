import frappe

CLIENT_SCRIPTS = ("Room Booking Calculation",)
SERVER_SCRIPTS = ("Room Booking Invoice", "Payment Entry After Submit", "Payment Entry After Cancel")


def execute():
	"""Логика перенесена в room_booking.js, api.py и doc_events — удаляем записи скриптов.

	Пока они существуют, код выполняется дважды: и из файлов приложения, и из базы.
	"""
	for doctype, names in (("Client Script", CLIENT_SCRIPTS), ("Server Script", SERVER_SCRIPTS)):
		for name in names:
			if frappe.db.exists(doctype, name):
				frappe.delete_doc(doctype, name, ignore_permissions=True, force=True)
