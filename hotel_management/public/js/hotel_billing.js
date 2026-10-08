// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Счета и оплата брони — общий модуль формы брони, групповой брони и шахматки.
//
// Подключение: файл вставляется через include в комментарии в начало файла формы или
// страницы, поэтому первая строка этого файла должна оставаться комментарием.
//
//   hotel_management.billing.load_css()               — стили сводки, карточек и диалога оплаты;
//   hotel_management.billing.summary_html(rows)       — плательщики брони и их счета;
//   hotel_management.billing.make_invoices(booking, rows, on_done) — выставить счета брони;
//   hotel_management.billing.pay(rows, { on_done })   — выбор счёта (если их несколько) и оплата.
//
// rows — счета плательщиков с сервера (hotel_management.billing.get_billing + payer_name).

frappe.provide("hotel_management.billing");

(() => {
	const billing = hotel_management.billing;

	const STATUS_COLOR = {
		Paid: "green",
		"Partially Paid": "orange",
		Unpaid: "red",
		Outdated: "orange",
		"Not Invoiced": "gray",
		"Nothing to Pay": "gray",
	};

	billing.load_css = () => frappe.require("/assets/hotel_management/css/hotel_billing.css");

	billing.esc = (value) => frappe.utils.escape_html(value == null ? "" : String(value));

	// строка «подпись — значение»; value — готовый HTML
	billing.info_row = (label, value) =>
		`<div class="rcb-row"><span class="rcb-label">${billing.esc(label)}</span><span class="rcb-value">${value}</span></div>`;

	billing.money_formatter = (currency) => {
		currency = currency || frappe.defaults.get_default("currency");
		return (value) => format_currency(value || 0, currency);
	};

	billing.status_pill = (status) =>
		`<span class="indicator-pill ${STATUS_COLOR[status] || "gray"}">${billing.esc(__(status))}</span>`;

	billing.invoice_link = (name) =>
		name
			? `<a href="${frappe.utils.get_form_link("Sales Invoice", name)}">${billing.esc(name)}</a>`
			: "—";

	// плательщики брони: доля, сумма, счёт и его состояние
	billing.summary_html = (rows, currency) => {
		if (!rows || !rows.length) return "";
		const money = billing.money_formatter(currency);
		const esc = billing.esc;
		return `<div class="hb-payers">${rows
			.map((row) => {
				const due =
					row.payable && flt(row.outstanding_amount) > 0
						? `<span class="hb-due">${esc(__("Outstanding"))}: ${money(row.outstanding_amount)}</span>`
						: "";
				const shared = row.shared
					? `<span class="text-muted">${esc(__("group invoice {0}", [money(row.invoice_total)]))}</span>`
					: "";
				return `<div class="hb-payer">
					<div class="hb-payer-head">
						<span class="hb-payer-name">${esc(row.payer_name || row.payer)}</span>
						<span class="text-muted">${flt(row.share)}%</span>
						<span class="hb-payer-amount">${money(row.amount)}</span>
					</div>
					<div class="hb-payer-invoice">
						${billing.status_pill(row.status)}
						${billing.invoice_link(row.sales_invoice)}
						${shared}
						${due}
					</div>
				</div>`;
			})
			.join("")}</div>`;
	};

	billing.needs_invoices = (rows) =>
		(rows || []).some((row) => row.status === "Not Invoiced" || row.status === "Outdated");

	// выставить недостающие и пересоздать устаревшие счета брони; устаревшие счета
	// отменяются, поэтому сначала спрашиваем
	billing.make_invoices = (room_booking, rows, on_done) => {
		const make = () =>
			frappe.call({
				method: "hotel_management.api.make_booking_invoices",
				args: { room_booking },
				freeze: true,
				freeze_message: __("Creating Sales Invoice..."),
				callback: (r) => {
					if (r.message && r.message.length) {
						frappe.show_alert({
							message: __("Sales Invoices created: {0}", [r.message.join(", ")]),
							indicator: "green",
						});
					}
					on_done && on_done(r.message || []);
				},
			});

		const outdated = [
			...new Set((rows || []).filter((row) => row.status === "Outdated").map((row) => row.sales_invoice)),
		];
		if (outdated.length) {
			frappe.confirm(
				__("Sales Invoice {0} will be cancelled and a new one created. Continue?", [outdated.join(", ")]),
				make
			);
		} else {
			make();
		}
	};

	// счета, по которым можно принять оплату (общий счёт группы — один раз)
	billing.payable = (rows) => {
		const seen = new Set();
		return (rows || []).filter((row) => {
			if (!row.payable || seen.has(row.sales_invoice)) return false;
			seen.add(row.sales_invoice);
			return true;
		});
	};

	// оплата: один счёт — сразу диалог оплаты, несколько — сначала выбор счёта
	billing.pay = async (rows, options = {}) => {
		const payable = billing.payable(rows);
		if (!payable.length) {
			frappe.msgprint(__("There are no invoices to pay"));
			return;
		}
		if (payable.length === 1) return billing.payment_dialog(payable[0], options);

		const money = billing.money_formatter(payable[0].currency);
		const label = (row) =>
			`${row.payer_name || row.payer} · ${row.sales_invoice} · ${money(row.outstanding_amount)}`;
		const dialog = new frappe.ui.Dialog({
			title: __("Choose Invoice"),
			fields: [
				{
					fieldname: "invoice",
					label: __("Sales Invoice"),
					fieldtype: "Select",
					reqd: 1,
					options: payable.map((row) => ({ value: row.sales_invoice, label: label(row) })),
					default: payable[0].sales_invoice,
				},
			],
			primary_action_label: __("Pay"),
			primary_action: ({ invoice }) => {
				dialog.hide();
				billing.payment_dialog(
					payable.find((row) => row.sales_invoice === invoice),
					options
				);
			},
		});
		dialog.show();
	};

	// оплата одного счёта: вкладка на каждый способ оплаты из профиля отеля брони
	billing.payment_dialog = async (invoice, options = {}) => {
		await billing.load_css();
		const modes = await frappe.xcall("hotel_management.api.get_payment_modes", {
			sales_invoice: invoice.sales_invoice,
		});
		if (!modes.length) {
			frappe.msgprint({
				title: __("Payment"),
				indicator: "orange",
				message: __("Add Modes of Payment in the Hotel Profile of the booking"),
			});
			return;
		}

		const money = billing.money_formatter(invoice.currency);
		const outstanding = flt(invoice.outstanding_amount);

		const dialog = new frappe.ui.Dialog({
			title: __("Payment"),
			size: "large",
			fields: [
				{
					fieldname: "customer",
					label: __("Payer"),
					fieldtype: "Link",
					options: "Customer",
					read_only: 1,
					default: invoice.payer,
				},
				{
					fieldname: "posting_date",
					label: __("Posting Date"),
					fieldtype: "Date",
					reqd: 1,
					default: frappe.datetime.get_today(),
				},
				{ fieldtype: "Column Break" },
				{
					fieldname: "sales_invoice",
					label: __("Sales Invoice"),
					fieldtype: "Link",
					options: "Sales Invoice",
					read_only: 1,
					default: invoice.sales_invoice,
				},
				{
					fieldname: "outstanding_amount",
					label: __("Outstanding Amount"),
					fieldtype: "Currency",
					read_only: 1,
					default: outstanding,
				},
				{ fieldtype: "Section Break" },
				{ fieldname: "payments", fieldtype: "HTML" },
				{ fieldname: "balance", fieldtype: "HTML" },
			],
			primary_action_label: __("Pay"),
			primary_action: (values) => {
				const payments = get_payments();
				if (!payments.length) {
					frappe.msgprint(__("Enter an amount in at least one Mode of Payment"));
					return;
				}
				confirm_payment(invoice, values.posting_date, payments, options, () => dialog.hide());
			},
		});
		dialog.$wrapper.addClass("rc-booking-dialog");

		// --- вкладки: по одной на способ оплаты --------------------------------------
		const $root = $(`<div class="rcp">
			<div class="rcp-tabs" role="tablist"></div>
			<div class="rcp-panes"></div>
		</div>`).appendTo(dialog.fields_dict.payments.$wrapper.empty());
		const $balance = dialog.fields_dict.balance.$wrapper;

		const tabs = modes.map((mode, i) => {
			const $tab = $(`<button type="button" class="rcp-tab" role="tab">
				<span class="rcp-tab-label"></span><span class="rcp-tab-amount"></span>
			</button>`).appendTo($root.find(".rcp-tabs"));
			$tab.find(".rcp-tab-label").text(__(mode.mode_of_payment));

			const $pane = $(`<div class="rcp-pane" role="tabpanel">
				<div class="rcp-pane-grid">
					<div class="rcp-amount"></div>
					<div class="rcp-reference"></div>
				</div>
				<button type="button" class="btn btn-default btn-xs rcp-fill">${__("Fill Remaining")}</button>
			</div>`).appendTo($root.find(".rcp-panes"));

			const amount = frappe.ui.form.make_control({
				parent: $pane.find(".rcp-amount"),
				df: {
					fieldtype: "Currency",
					fieldname: `amount_${i}`,
					label: __("Paid Amount"),
					non_negative: 1,
					change: () => update_balance(),
				},
				render_input: true,
			});
			amount.refresh();
			// остаток пересчитываем прямо при вводе, не дожидаясь ухода с поля
			amount.$input.on("input", () => update_balance());

			// номер документа нужен для банковских платежей; для наличных поле не показываем
			const reference =
				mode.type !== "Cash"
					? frappe.ui.form.make_control({
							parent: $pane.find(".rcp-reference"),
							df: {
								fieldtype: "Data",
								fieldname: `reference_no_${i}`,
								label: __("Reference No"),
								description: __("For bank payments; defaults to the booking number"),
							},
							render_input: true,
					  })
					: null;
			reference && reference.refresh();

			const tab = { mode, $tab, $pane, amount, reference };
			$tab.on("click", () => activate(tab));
			$pane.find(".rcp-fill").on("click", () => {
				const remaining = outstanding - total_paid();
				if (remaining <= 0) return;
				amount.set_value(amount_of(tab) + remaining);
			});
			return tab;
		});

		const amount_of = (tab) => Math.max(flt(tab.amount.get_value()), 0);
		const total_paid = () => tabs.reduce((sum, tab) => sum + amount_of(tab), 0);
		const get_payments = () =>
			tabs
				.filter((tab) => amount_of(tab) > 0)
				.map((tab) => ({
					mode_of_payment: tab.mode.mode_of_payment,
					amount: amount_of(tab),
					reference_no: (tab.reference && tab.reference.get_value()) || "",
				}));

		const activate = (active) => {
			tabs.forEach((tab) => {
				tab.$tab.toggleClass("active", tab === active).attr("aria-selected", tab === active);
				tab.$pane.toggleClass("active", tab === active);
			});
			setTimeout(() => active.amount.set_focus(), 0);
		};

		const update_balance = () => {
			tabs.forEach((tab) => tab.$tab.find(".rcp-tab-amount").text(amount_of(tab) ? money(amount_of(tab)) : ""));
			$balance.html(balance_html(outstanding, total_paid(), money));
		};

		// по умолчанию вся сумма — первым способом оплаты
		tabs[0].amount.set_value(outstanding);
		activate(tabs[0]);
		update_balance();

		options.before_show && options.before_show();
		dialog.show();
	};

	function balance_html(outstanding, paid, money) {
		const remaining = flt(outstanding - paid, 2);
		const state = remaining > 0 ? "rcp-due" : remaining < 0 ? "rcp-over" : "rcp-settled";
		return `<div class="rcb-money rcp-balance">
			<div class="rcb-row"><span class="rcb-label">${__("Outstanding Amount")}</span>
				<span class="rcb-value">${money(outstanding)}</span></div>
			<div class="rcb-row"><span class="rcb-label">${__("Paying Now")}</span>
				<span class="rcb-value">${money(paid)}</span></div>
			<div class="rcb-total ${state}"><div class="rcb-row">
				<span class="rcb-label">${remaining < 0 ? __("Overpayment") : __("Remaining to Pay")}</span>
				<span class="rcb-value">${money(Math.abs(remaining))}</span></div></div>
		</div>`;
	}

	function confirm_payment(invoice, posting_date, payments, options, on_close) {
		const esc = billing.esc;
		const money = billing.money_formatter(invoice.currency);
		const outstanding = flt(invoice.outstanding_amount);
		const paid = payments.reduce((sum, p) => sum + flt(p.amount), 0);

		const lines = payments
			.map(
				(p) =>
					`<div class="rcb-service"><span>${esc(__(p.mode_of_payment))}${
						p.reference_no ? ` · ${esc(p.reference_no)}` : ""
					}</span><span>${money(p.amount)}</span></div>`
			)
			.join("");

		const confirm = new frappe.ui.Dialog({
			title: __("Confirm Payment"),
			fields: [{ fieldtype: "HTML", fieldname: "body" }],
			primary_action_label: __("Confirm"),
			primary_action: () => {
				frappe.call({
					method: "hotel_management.api.make_invoice_payments",
					args: { sales_invoice: invoice.sales_invoice, payments, posting_date },
					freeze: true,
					freeze_message: __("Creating Payment Entry..."),
					callback: (r) => {
						if (!r.message) return;
						confirm.hide();
						on_close && on_close();
						frappe.show_alert({
							message: __("Payment Entries {0} created", [r.message.join(", ")]),
							indicator: "green",
						});
						options.on_done && options.on_done(r.message);
					},
				});
			},
			secondary_action_label: __("Back"),
			secondary_action: () => confirm.hide(),
		});
		confirm.$wrapper.addClass("rc-booking-dialog");
		confirm.fields_dict.body.$wrapper.html(`
			<div class="rcb">
				<div class="rcb-grid">
					<div>
						${billing.info_row(__("Payer"), esc(invoice.payer_name || invoice.payer))}
						${options.room ? billing.info_row(__("Room"), esc(options.room)) : ""}
					</div>
					<div>
						${billing.info_row(__("Sales Invoice"), esc(invoice.sales_invoice))}
						${billing.info_row(__("Posting Date"), esc(frappe.datetime.str_to_user(posting_date)))}
					</div>
				</div>
				<div class="rcb-money">
					<div class="rcr-title">${esc(__("Mode of Payment"))}</div>
					<div class="rcb-services">${lines}</div>
				</div>
				${balance_html(outstanding, paid, money)}
				${
					paid > outstanding
						? `<div class="rcb-warning">${esc(
								__("Overpayment of {0} will be recorded as an advance", [money(paid - outstanding)])
						  )}</div>`
						: ""
				}
			</div>`);
		confirm.show();
	}
})();
