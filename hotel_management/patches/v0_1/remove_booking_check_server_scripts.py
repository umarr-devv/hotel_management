import frappe


def execute():
	"""Проверка пересечений перенесена в RoomBooking.validate — удаляем старые Server Scripts."""
	for name in ("Room Booking Check", "Room Booking Check After Submit"):
		if frappe.db.exists("Server Script", name):
			frappe.delete_doc("Server Script", name, ignore_permissions=True, force=True)
