// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

frappe.query_reports["Hotel Guest History"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			default: frappe.datetime.add_months(frappe.datetime.get_today(), -12),
			reqd: 1,
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
			reqd: 1,
		},
		{ fieldname: "customer", label: __("Guest"), fieldtype: "Link", options: "Customer" },
		{
			fieldname: "room_type",
			label: __("Room Type"),
			fieldtype: "Link",
			options: "Room Type",
		},
		{
			fieldname: "hotel_building",
			label: __("Building"),
			fieldtype: "Link",
			options: "Hotel Building",
		},
		{ fieldname: "min_stays", label: __("Minimum Stays"), fieldtype: "Int", default: 0 },
	],
};
