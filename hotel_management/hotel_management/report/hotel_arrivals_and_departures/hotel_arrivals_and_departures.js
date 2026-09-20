// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

frappe.query_reports["Hotel Arrivals and Departures"] = {
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
			fieldname: "movement",
			label: __("Movement"),
			fieldtype: "Select",
			options: ["All", "Arrival", "Departure", "In House"].join("\n"),
			default: "All",
		},
		{
			fieldname: "hotel_building",
			label: __("Building"),
			fieldtype: "Link",
			options: "Hotel Building",
		},
		{
			fieldname: "room_type",
			label: __("Room Type"),
			fieldtype: "Link",
			options: "Room Type",
		},
		{ fieldname: "customer", label: __("Customer"), fieldtype: "Link", options: "Customer" },
		{
			fieldname: "status",
			label: __("Status"),
			fieldtype: "Select",
			options: ["", "Booking", "Checked In", "Checked Out", "Completed"].join("\n"),
		},
	],

	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (column.fieldname === "movement") {
			const colors = { Arrival: "green", Departure: "orange", "In House": "blue" };
			const color = colors[data.movement] || "gray";
			value = `<span class="indicator-pill ${color}">${__(data.movement)}</span>`;
		}
		return value;
	},
};
