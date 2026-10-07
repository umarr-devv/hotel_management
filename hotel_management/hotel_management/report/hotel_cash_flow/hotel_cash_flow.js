// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

frappe.query_reports["Hotel Cash Flow"] = {
	filters: [
		{
			fieldname: "from_datetime",
			label: __("From Date"),
			fieldtype: "Datetime",
			default: `${frappe.datetime.get_today()} 00:00:00`,
			reqd: 1,
		},
		{
			fieldname: "to_datetime",
			label: __("To Date"),
			fieldtype: "Datetime",
			default: `${frappe.datetime.get_today()} 23:59:59`,
			reqd: 1,
		},
		{
			fieldname: "hotel_profile",
			label: __("Hotel Profile"),
			fieldtype: "Link",
			options: "Hotel Profile",
			reqd: 1,
			on_change(report) {
				// сотрудники у каждого профиля свои — выбор сбрасываем
				const employees = report.get_filter_value("employees") || [];
				if (employees.length) report.set_filter_value("employees", []); // отчёт обновится сам
				else report.refresh();
			},
		},
		{
			// пусто — документы всех сотрудников профиля
			fieldname: "employees",
			label: __("Employees"),
			fieldtype: "MultiSelectList",
			get_data(txt) {
				const hotel_profile = frappe.query_report.get_filter_value("hotel_profile");
				if (!hotel_profile) return [];
				return frappe.xcall(
					"hotel_management.hotel_management.report.hotel_cash_flow.hotel_cash_flow.get_employee_options",
					{ hotel_profile, txt }
				);
			},
		},
	],

	async onload(report) {
		if (report.get_filter_value("hotel_profile")) return;
		// по умолчанию — первый профиль, разрешённый пользователю
		const profiles = await frappe.db.get_list("Hotel Profile", { order_by: "creation asc", limit: 1 });
		if (profiles.length) report.set_filter_value("hotel_profile", profiles[0].name);
	},

	formatter(value, row, column, data, default_formatter) {
		if (data && data.is_section) {
			if (column.fieldname === "account") return `<b>${frappe.utils.escape_html(value || "")}</b>`;
			return value == null || value === "" ? "" : `<b>${default_formatter(value, row, column, data)}</b>`;
		}
		return default_formatter(value, row, column, data);
	},
};
