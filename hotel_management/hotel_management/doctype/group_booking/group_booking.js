// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Форма групповой брони. Брони номеров создаёт и обновляет сервер при сохранении группы.
// Счета и оплата — общий модуль hotel_billing.js:
// {% include 'hotel_management/public/js/hotel_billing.js' %}

frappe.ui.form.on("Group Booking", {
	setup(frm) {
		// отключённые номера и номера отключённых типов в выборе не показываются
		frm.set_query("room", "rooms", () => ({ query: "hotel_management.api.active_room_query" }));
		// тариф строки — только из активных тарифов типа её номера
		frm.set_query("room_rate", "rooms", (doc, cdt, cdn) => ({
			query: "hotel_management.api.room_rate_query",
			filters: { room: locals[cdt][cdn].room },
		}));
		hotel_management.billing.load_css();
	},

	async onload(frm) {
		if (frm.is_new()) await set_defaults(frm);
	},

	refresh(frm) {
		render_summary(frm);
		add_buttons(frm);
		frm.fields_dict.rooms.grid.add_custom_button(__("Add Free Rooms"), () => add_free_rooms(frm));
	},

	// даты и тариф группы переносятся в строки, которые ещё можно менять
	check_in(frm) {
		apply_to_rows(frm, "check_in");
	},

	check_out(frm) {
		apply_to_rows(frm, "check_out");
	},

	room_rate(frm) {
		apply_to_rows(frm, "room_rate");
	},
});

frappe.ui.form.on("Group Booking Room", {
	rooms_add(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		["check_in", "check_out", "room_rate"].forEach((field) => {
			if (!row[field] && frm.doc[field]) frappe.model.set_value(cdt, cdn, field, frm.doc[field]);
		});
	},
});

// компания по умолчанию; профиль отеля — если он единственный
async function set_defaults(frm) {
	if (!frm.doc.company) {
		const company =
			frappe.defaults.get_user_default("Company") || frappe.defaults.get_global_default("company");
		company && frm.set_value("company", company);
	}
	if (!frm.doc.hotel_profile) {
		const profiles = await frappe.db.get_list("Hotel Profile", { limit: 2 });
		profiles.length === 1 && frm.set_value("hotel_profile", profiles[0].name);
	}
}

function summary(frm) {
	return (frm.doc.__onload && frm.doc.__onload.summary) || {};
}

// строку можно менять, пока её бронь не заселена; выезд — и у заселённой (продление)
function row_editable(frm, row, field) {
	if (!row.room_booking) return true;
	const booking = (summary(frm).bookings || []).find((b) => b.name === row.room_booking);
	if (!booking || booking.status === "Booking") return true;
	return field === "check_out" && booking.status === "Checked In";
}

function apply_to_rows(frm, field) {
	if (!frm.doc[field]) return;
	(frm.doc.rooms || []).forEach((row) => {
		if (row_editable(frm, row, field)) row[field] = frm.doc[field];
	});
	frm.refresh_field("rooms");
}

// --- подбор номеров -------------------------------------------------------------

function add_free_rooms(frm) {
	if (!frm.doc.check_in || !frm.doc.check_out) {
		frappe.msgprint(__("Set Check In and Check Out of the group first"));
		return;
	}

	const dialog = new frappe.ui.Dialog({
		title: __("Add Free Rooms"),
		fields: [
			{ fieldname: "room_type", label: __("Room Type"), fieldtype: "Link", options: "Room Type" },
			{
				fieldname: "hotel_building",
				label: __("Hotel Building"),
				fieldtype: "Link",
				options: "Hotel Building",
			},
			{ fieldtype: "Column Break" },
			{ fieldname: "count", label: __("Number of Rooms"), fieldtype: "Int", reqd: 1, default: 1 },
		],
		primary_action_label: __("Add"),
		primary_action: async (values) => {
			const rooms = await frappe.xcall(
				"hotel_management.hotel_management.doctype.group_booking.group_booking.get_free_rooms",
				{
					check_in: frm.doc.check_in,
					check_out: frm.doc.check_out,
					room_type: values.room_type,
					hotel_building: values.hotel_building,
					room_rate: frm.doc.room_rate,
					exclude: (frm.doc.rooms || []).map((row) => row.room).filter(Boolean),
					count: values.count,
				}
			);
			if (!rooms.length) {
				frappe.msgprint(__("No free rooms for these dates"));
				return;
			}

			rooms.forEach((room) =>
				frm.add_child("rooms", {
					room: room.name,
					room_rate: room.room_rate,
					check_in: frm.doc.check_in,
					check_out: frm.doc.check_out,
				})
			);
			frm.refresh_field("rooms");
			dialog.hide();

			const message =
				rooms.length < cint(values.count)
					? __("Only {0} free rooms found, all of them added", [rooms.length])
					: __("Rooms added: {0}", [rooms.length]);
			frappe.show_alert({ message, indicator: rooms.length < cint(values.count) ? "orange" : "green" });
		},
	});
	dialog.show();
}

// --- сводка и действия ------------------------------------------------------------

function render_summary(frm) {
	const $wrapper = frm.fields_dict.summary.$wrapper;
	const data = summary(frm);
	if (frm.is_new() || !(data.bookings || []).length) {
		$wrapper.html(
			`<div class="text-muted small">${__("Room bookings are created when the group is saved")}</div>`
		);
		return;
	}

	const esc = hotel_management.billing.esc;
	const money = hotel_management.billing.money_formatter();
	const link = (doctype, name) => `<a href="${frappe.utils.get_form_link(doctype, name)}">${esc(name)}</a>`;
	const pay_color = { Paid: "green", "Partially Paid": "orange", Unpaid: "red" };

	const bookings = data.bookings
		.map(
			(b) => `<tr>
				<td>${link("Room Booking", b.name)}</td>
				<td>${esc(b.room)}</td>
				<td>${esc(b.customer)}</td>
				<td>${esc(__(b.status))}</td>
				<td><span class="indicator-pill ${pay_color[b.pay_status] || "gray"}">${esc(
					__(b.pay_status || "Unpaid")
				)}</span></td>
				<td class="hb-num">${money(b.total_amount)}</td>
			</tr>`
		)
		.join("");

	const invoices = (data.invoices || [])
		.map(
			(row) => `<tr>
				<td>${link("Sales Invoice", row.sales_invoice)}</td>
				<td colspan="2">${esc(row.payer_name || row.payer)}</td>
				<td>${hotel_management.billing.status_pill(row.status)}</td>
				<td class="hb-num">${money(row.invoice_total)}</td>
				<td class="hb-num">${
					flt(row.outstanding_amount) > 0
						? `<span class="hb-due">${money(row.outstanding_amount)}</span>`
						: "—"
				}</td>
			</tr>`
		)
		.join("");

	$wrapper.html(`
		<table class="hb-bookings">
			<thead><tr>
				<th>${__("Room Booking")}</th><th>${__("Room")}</th><th>${__("Customer")}</th>
				<th>${__("Status")}</th><th>${__("Pay Status")}</th><th class="hb-num">${__("Total")}</th>
			</tr></thead>
			<tbody>${bookings}</tbody>
		</table>
		${
			invoices
				? `<table class="hb-bookings" style="margin-top: 16px">
					<thead><tr>
						<th>${__("Sales Invoice")}</th><th colspan="2">${__("Payer")}</th><th>${__("Status")}</th>
						<th class="hb-num">${__("Invoiced")}</th><th class="hb-num">${__("Outstanding")}</th>
					</tr></thead>
					<tbody>${invoices}</tbody>
				</table>`
				: ""
		}
	`);
}

function add_buttons(frm) {
	if (frm.is_new()) return;
	const data = summary(frm);
	const group_api = "hotel_management.hotel_management.doctype.group_booking.group_booking";

	// действия workflow по всем броням группы, где они доступны
	(data.actions || []).forEach(({ action, count }) => {
		frm.add_custom_button(
			`${__(action)} (${count})`,
			() => {
				if (frm.is_dirty()) {
					frappe.msgprint(__("Save the group first"));
					return;
				}
				frappe.confirm(__("Apply action {0} to {1} bookings of the group?", [__(action).bold(), count]), () =>
					frappe.call({
						method: `${group_api}.apply_group_action`,
						args: { group_booking: frm.doc.name, action },
						freeze: true,
						callback: (r) => {
							frappe.show_alert({
								message: __("{0}: {1} bookings", [__(action), (r.message || []).length]),
								indicator: "green",
							});
							frm.reload_doc();
						},
					})
				);
			},
			__("Actions")
		);
	});

	if (data.needs_invoices) {
		frm.add_custom_button(__("Create Invoices"), () => {
			if (frm.is_dirty()) {
				frappe.msgprint(__("Save the group first"));
				return;
			}
			frappe.call({
				method: `${group_api}.make_group_invoices`,
				args: { group_booking: frm.doc.name },
				freeze: true,
				freeze_message: __("Creating Sales Invoice..."),
				callback: () => frm.reload_doc(),
			});
		});
	}

	const payable = hotel_management.billing.payable(data.invoices);
	if (payable.length) {
		frm.add_custom_button(__("Pay"), () =>
			hotel_management.billing.pay(payable, { on_done: () => frm.reload_doc() })
		);
	}
}
