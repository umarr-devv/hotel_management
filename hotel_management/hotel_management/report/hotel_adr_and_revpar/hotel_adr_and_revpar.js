// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

frappe.query_reports["Hotel ADR and RevPAR"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			default: frappe.datetime.add_days(frappe.datetime.get_today(), -30),
			reqd: 1,
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
			reqd: 1,
		},
		{
			fieldname: "group_by",
			label: __("Group By"),
			fieldtype: "Select",
			options: ["Date", "Month", "Room Type", "Hotel Building", "Hotel Floor", "Room"].join(
				"\n"
			),
			default: "Month",
			reqd: 1,
		},
		{
			fieldname: "hotel_building",
			label: __("Building"),
			fieldtype: "Link",
			options: "Hotel Building",
		},
		{
			fieldname: "hotel_floor",
			label: __("Floor"),
			fieldtype: "Link",
			options: "Hotel Floor",
			get_query() {
				const building = frappe.query_report.get_filter_value("hotel_building");
				return building ? { filters: { building } } : {};
			},
		},
		{
			fieldname: "room_type",
			label: __("Room Type"),
			fieldtype: "Link",
			options: "Room Type",
		},
	],
};
