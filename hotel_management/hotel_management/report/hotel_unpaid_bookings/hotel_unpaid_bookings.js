// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

frappe.query_reports["Hotel Unpaid Bookings"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			default: frappe.datetime.add_months(frappe.datetime.get_today(), -3),
			reqd: 1,
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
			reqd: 1,
		},
		{ fieldname: "customer", label: __("Customer"), fieldtype: "Link", options: "Customer" },
		{
			fieldname: "hotel_building",
			label: __("Building"),
			fieldtype: "Link",
			options: "Hotel Building",
		},
		{
			fieldname: "status",
			label: __("Status"),
			fieldtype: "Select",
			options: ["", "Booking", "Checked In", "Checked Out", "Completed"].join("\n"),
		},
		{
			fieldname: "only_checked_out",
			label: __("Only Checked Out Guests"),
			fieldtype: "Check",
			default: 0,
		},
	],

	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (column.fieldname === "balance_due" && data && flt(data.balance_due) > 0) {
			value = `<span style="color: var(--red-500)">${value}</span>`;
		}
		return value;
	},
};
