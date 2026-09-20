# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Досинхронизация документов уровня приложения после bench migrate."""

import os

import frappe
from frappe.modules.import_file import import_file_by_path
from frappe.modules.utils import get_app_level_directory_path

APP_LEVEL_FOLDERS = ("workspace_sidebar", "desktop_icon", "sidebar_item_group")


def sync_app_level_docs():
	"""Принудительно перечитать сайдбар и иконку рабочего стола из файлов приложения.

	frappe импортирует такой файл, только если поле modified в нём новее, чем в базе.
	Любое сохранение сайдбара в интерфейсе делает запись в базе новее файла, и
	изменения из репозитория (новые пункты, отчёты) тихо перестают доезжать до сайта.
	Файл в приложении — источник правды, поэтому импортируем его принудительно.
	"""
	for folder_name in APP_LEVEL_FOLDERS:
		folder = get_app_level_directory_path(folder_name, "hotel_management")
		if not os.path.isdir(folder):
			continue

		for filename in sorted(os.listdir(folder)):
			if not filename.endswith(".json"):
				continue
			import_file_by_path(os.path.join(folder, filename), force=True, ignore_version=True)

	frappe.clear_cache()
