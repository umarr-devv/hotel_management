import frappe
from frappe.model.utils.rename_field import rename_field


def execute():
	"""Тариф стал суточным: rate_by_hour → rate_per_day.

	Значения переносятся как есть — цены в тарифах пользователь проверяет сам.
	Старые брони не пересчитываются.
	"""
	for doctype in ("Room Type Rate", "Room Booking"):
		if frappe.db.has_column(doctype, "rate_by_hour"):
			rename_field(doctype, "rate_by_hour", "rate_per_day")
