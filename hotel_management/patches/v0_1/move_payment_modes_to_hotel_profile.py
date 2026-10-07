import frappe


def execute():
	"""Способы оплаты переехали из Hotel Settings в Hotel Profile — копируем их во все профили.

	Старый doctype к этому моменту уже не в приложении, но его таблица ещё в базе:
	frappe удаляет осиротевшие doctype после post_model_sync патчей.
	"""
	if not frappe.db.table_exists("Hotel Settings Mode of Payment"):
		return

	modes = frappe.db.sql_list(
		"""
		select mode_of_payment from `tabHotel Settings Mode of Payment`
		where parent = 'Hotel Settings' and ifnull(mode_of_payment, '') != ''
		order by idx asc
		"""
	)
	if not modes:
		return

	for name in frappe.get_all("Hotel Profile", pluck="name"):
		profile = frappe.get_doc("Hotel Profile", name)
		if profile.modes_of_payment:
			continue
		for mode in dict.fromkeys(modes):
			if frappe.db.exists("Mode of Payment", mode):
				profile.append("modes_of_payment", {"mode_of_payment": mode})
		profile.flags.ignore_permissions = True
		profile.flags.ignore_mandatory = True
		profile.flags.ignore_links = True
		profile.save()
