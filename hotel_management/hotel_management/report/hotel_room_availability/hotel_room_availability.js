// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

frappe.query_reports["Hotel Room Availability"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
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
			fieldname: "availability",
			label: __("Availability"),
			fieldtype: "Select",
			options: ["All", "Free", "Partially Booked", "Fully Booked"].join("\n"),
			default: "All",
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

	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (column.fieldname === "status") {
			const colors = { Free: "green", "Partially Booked": "orange", "Fully Booked": "red" };
			value = `<span class="indicator-pill ${colors[data.status] || "gray"}">${__(
				data.status
			)}</span>`;
		}
		return value;
	},
};
