// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

(() => {
	frappe.pages["room-chessboard"].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Room Chessboard"),
			single_column: true,
		});

		frappe
			.require([
				"/assets/hotel_management/js/lib/vis-timeline.min.js",
				"/assets/hotel_management/css/lib/vis-timeline.min.css",
				"/assets/hotel_management/css/room_chessboard.css",
			])
			.then(() => {
				wrapper.chessboard = new hotel_management.RoomChessboard(page, wrapper);
			});
	};

	frappe.pages["room-chessboard"].on_page_show = function (wrapper) {
		// возвращаемся с формы брони — подтягиваем свежие данные
		wrapper.chessboard && wrapper.chessboard.load_bookings();
	};

	frappe.provide("hotel_management");

	const API = "hotel_management.hotel_management.page.room_chessboard.room_chessboard";
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;

	const SCALES = {
		day: { label: __("Day"), span: DAY, lead: 0 },
		week: { label: __("Week"), span: 7 * DAY, lead: DAY },
		month: { label: __("Month"), span: 30 * DAY, lead: 2 * DAY },
	};

	const STATUSES = ["Booking", "Checked In", "Checked Out", "Completed"];

	hotel_management.RoomChessboard = class RoomChessboard {
		constructor(page, wrapper) {
			this.page = page;
			this.wrapper = $(wrapper);
			this.scale = "week";

			this.make_filters();
			this.make_actions();
			this.make_layout();
			this.make_timeline();

			this.load_bookings = frappe.utils.debounce(this._load_bookings.bind(this), 250);
			this.reload();
		}

		// ---------------------------------------------------------------- UI setup

		make_filters() {
			const on_change = () => this.reload();
			this.filters = {
				hotel_building: this.page.add_field({
					fieldname: "hotel_building",
					label: __("Hotel Building"),
					fieldtype: "Link",
					options: "Hotel Building",
					change: on_change,
				}),
				room_type: this.page.add_field({
					fieldname: "room_type",
					label: __("Room Type"),
					fieldtype: "Link",
					options: "Room Type",
					change: on_change,
				}),
				status: this.page.add_field({
					fieldname: "status",
					label: __("Status"),
					fieldtype: "Select",
					options: [{ label: "", value: "" }].concat(
						STATUSES.map((s) => ({ label: __(s), value: s }))
					),
					change: () => this.load_bookings(),
				}),
				go_to: this.page.add_field({
					fieldname: "go_to",
					label: __("Go to Date"),
					fieldtype: "Date",
					change: () => {
						const value = this.filters.go_to.get_value();
						if (value) this.show_period(parse_dt(value));
					},
				}),
			};
		}

		make_actions() {
			this.page.set_primary_action(__("New Booking"), () => frappe.new_doc("Room Booking"));
			this.page.set_secondary_action(__("Refresh"), () => this.reload());
		}

		make_layout() {
			const scale_buttons = Object.entries(SCALES)
				.map(
					([key, s]) =>
						`<button class="btn btn-default btn-sm" data-scale="${key}">${s.label}</button>`
				)
				.join("");

			const legend = STATUSES.map(
				(s) => `<span class="rc-legend-item">
					<span class="rc-legend-swatch rc-status-${slug(s)}"></span>${__(s)}
				</span>`
			).join("");

			this.$body = $(`
				<div class="rc-wrapper">
					<div class="rc-toolbar">
						<div class="btn-group">
							<button class="btn btn-default btn-sm" data-action="prev" title="${__("Previous")}">
								&lsaquo;
							</button>
							<button class="btn btn-default btn-sm" data-action="today">${__("Today")}</button>
							<button class="btn btn-default btn-sm" data-action="next" title="${__("Next")}">
								&rsaquo;
							</button>
						</div>
						<div class="btn-group rc-scale">${scale_buttons}</div>
						<div class="rc-period"></div>
						<div class="rc-legend">
							${legend}
							<span class="rc-legend-item">
								<span class="rc-legend-swatch rc-legend-unpaid"></span>${__("Unpaid")}
							</span>
							<span class="rc-legend-item">
								<span class="rc-legend-swatch rc-legend-draft"></span>${__("Draft")}
							</span>
						</div>
					</div>
					<div class="rc-timeline"></div>
					<div class="rc-empty hidden">
						<p>${__("No rooms found")}</p>
						<a href="/app/hotel-room/new" class="btn btn-default btn-sm">${__("Create Hotel Room")}</a>
					</div>
					<div class="rc-hint text-muted">
						${__("Double-click a booking to open it, or an empty cell to create a new one. Ctrl + wheel to zoom.")}
					</div>
				</div>
			`).appendTo(this.page.main);

			this.$body.on("click", "[data-action]", (e) => {
				const action = $(e.currentTarget).attr("data-action");
				if (action === "today") this.show_period(new Date());
				else this.shift(action === "next" ? 1 : -1);
			});
			this.$body.on("click", "[data-scale]", (e) => {
				this.set_scale($(e.currentTarget).attr("data-scale"));
			});
			this.update_scale_buttons();

			$(window).on("resize.room_chessboard", frappe.utils.debounce(() => this.fit_height(), 150));
		}

		make_timeline() {
			this.groups = new vis.DataSet();
			this.items = new vis.DataSet();

			const container = this.$body.find(".rc-timeline").get(0);
			const [start, end] = this.period_for(new Date());

			this.timeline = new vis.Timeline(container, this.items, this.groups, {
				start,
				end,
				locale: (frappe.boot.lang || "en").split("-")[0],
				orientation: { axis: "top", item: "top" },
				stack: false,
				editable: false,
				selectable: true,
				moveable: true,
				zoomable: true,
				zoomKey: "ctrlKey",
				verticalScroll: true,
				horizontalScroll: false,
				showCurrentTime: true,
				zoomMin: 6 * HOUR,
				zoomMax: 120 * DAY,
				groupOrder: "order",
				margin: { item: { horizontal: 0, vertical: 6 }, axis: 6 },
				height: this.available_height(),
				tooltip: { followMouse: true, overflowMethod: "flip", delay: 150 },
				xss: {
					disabled: false,
					filterOptions: {
						whiteList: { div: ["class"], span: ["class"], b: [], br: [] },
					},
				},
				template: (item, element, data) => this.item_template(data),
				groupTemplate: (group) => this.group_template(group),
			});

			this.timeline.on("rangechanged", () => {
				this.update_period_label();
				this.load_bookings();
			});
			this.timeline.on("doubleClick", (props) => this.on_double_click(props));
			this.update_period_label();
		}

		// ---------------------------------------------------------------- data

		reload() {
			return this.load_rooms().then(() => this._load_bookings());
		}

		get_filter(name) {
			return this.filters[name].get_value() || null;
		}

		load_rooms() {
			return frappe
				.call({
					method: `${API}.get_rooms`,
					args: {
						hotel_building: this.get_filter("hotel_building"),
						room_type: this.get_filter("room_type"),
					},
				})
				.then((r) => this.set_groups(r.message || []));
		}

		_load_bookings() {
			if (!this.rooms || !this.rooms.length) {
				this.items.clear();
				return Promise.resolve();
			}
			// берём с запасом в одну ширину окна с каждой стороны
			const win = this.timeline.getWindow();
			const span = win.end - win.start;
			const start = new Date(win.start.getTime() - span);
			const end = new Date(win.end.getTime() + span);

			const request_id = (this._request_id = (this._request_id || 0) + 1);
			return frappe
				.call({
					method: `${API}.get_bookings`,
					args: {
						start: format_dt(start),
						end: format_dt(end),
						hotel_building: this.get_filter("hotel_building"),
						room_type: this.get_filter("room_type"),
						status: this.get_filter("status"),
					},
				})
				.then((r) => {
					if (request_id !== this._request_id) return; // устаревший ответ
					this.set_items(r.message || []);
				});
		}

		set_groups(rooms) {
			this.rooms = rooms;
			const room_names = new Set(rooms.map((r) => r.name));
			const groups = [];
			const buildings = new Map();

			rooms.forEach((room, index) => {
				const building_key = room.hotel_building || "";
				if (!buildings.has(building_key)) {
					const building = {
						id: `b::${building_key}`,
						kind: "building",
						label: room.hotel_building || __("No Building"),
						nestedGroups: [],
						showNested: true,
						order: index,
						className: "rc-group-building",
						floors: new Map(),
					};
					buildings.set(building_key, building);
					groups.push(building);
				}
				const building = buildings.get(building_key);

				const floor_key = room.hotel_floor || String(room.floor_number || "");
				if (!building.floors.has(floor_key)) {
					const floor = {
						id: `f::${building_key}::${floor_key}`,
						kind: "floor",
						label: floor_key
							? __("Floor {0}", [room.floor_number || room.hotel_floor])
							: __("No Floor"),
						nestedGroups: [],
						showNested: true,
						order: index,
						className: "rc-group-floor",
					};
					building.floors.set(floor_key, floor);
					building.nestedGroups.push(floor.id);
					groups.push(floor);
				}
				const floor = building.floors.get(floor_key);

				floor.nestedGroups.push(room.name);
				groups.push({
					id: room.name,
					kind: "room",
					label: room.room_number || room.name,
					room_type: room.room_type,
					order: index,
					className: "rc-group-room",
				});
			});

			groups.forEach((g) => delete g.floors);

			// сохраняем свёрнутость групп между перезагрузками
			groups.forEach((g) => {
				const old = this.groups.get(g.id);
				if (old && g.nestedGroups) g.showNested = old.showNested;
			});

			this.groups.clear();
			this.groups.add(groups);

			const existing = this.items.getIds();
			this.items.remove(existing.filter((id) => !room_names.has(this.items.get(id).group)));

			this.$body.find(".rc-empty").toggleClass("hidden", rooms.length > 0);
			this.$body.find(".rc-timeline").toggleClass("hidden", rooms.length === 0);
			this.fit_height();
		}

		set_items(bookings) {
			const items = bookings.map((b) => ({
				id: b.name,
				group: b.room,
				start: parse_dt(b.check_in),
				end: parse_dt(b.check_out),
				className: [
					"rc-item",
					`rc-status-${slug(b.status)}`,
					b.pay_status !== "Paid" ? "rc-unpaid" : "",
					b.docstatus === 0 ? "rc-draft" : "",
				].join(" "),
				title: this.tooltip_html(b),
				booking: b,
			}));

			const new_ids = new Set(items.map((i) => i.id));
			this.items.remove(this.items.getIds().filter((id) => !new_ids.has(id)));
			this.items.update(items);
		}

		// ---------------------------------------------------------------- templates

		group_template(group) {
			const el = document.createElement("div");
			el.className = `rc-group-label rc-group-label-${group.kind}`;

			const title = document.createElement("span");
			title.className = "rc-group-title";
			title.textContent = group.label;
			el.appendChild(title);

			if (group.kind === "room" && group.room_type) {
				const sub = document.createElement("span");
				sub.className = "rc-group-sub";
				sub.textContent = group.room_type;
				el.appendChild(sub);
			}
			return el;
		}

		item_template(item) {
			const b = item.booking;
			const el = document.createElement("div");
			el.className = "rc-item-content";

			const title = document.createElement("span");
			title.className = "rc-item-title";
			title.textContent = b.customer_name || b.customer || b.name;
			el.appendChild(title);

			if (b.guests) {
				const guests = document.createElement("span");
				guests.className = "rc-item-sub";
				guests.textContent = `+${b.guests}`;
				el.appendChild(guests);
			}
			return el;
		}

		tooltip_html(b) {
			const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
			const fmt = (v) => moment(parse_dt(v)).format("DD.MM.YYYY HH:mm");
			const rows = [
				[__("Room"), b.room],
				[__("Check In"), fmt(b.check_in)],
				[__("Check Out"), fmt(b.check_out)],
				[__("Hours"), flt(b.total_hours, 1)],
				[__("Guests"), b.guests],
				[__("Status"), __(b.status) + (b.docstatus === 0 ? ` (${__("Draft")})` : "")],
				[__("Pay Status"), __(b.pay_status || "Unpaid")],
				[__("Total"), format_currency(b.total_amount, b.currency)],
			];
			return `<div class="rc-tooltip">
				<div class="rc-tooltip-title"><b>${esc(b.customer_name || b.customer)}</b></div>
				<div class="rc-tooltip-sub">${esc(b.name)}</div>
				${rows
					.map(
						([label, value]) =>
							`<div class="rc-tooltip-row"><span>${esc(label)}</span><span>${esc(
								value
							)}</span></div>`
					)
					.join("")}
			</div>`;
		}

		// ---------------------------------------------------------------- interactions

		on_double_click(props) {
			if (props.item) {
				frappe.set_route("Form", "Room Booking", props.item);
				return;
			}
			const group = props.group && this.groups.get(props.group);
			if (!group || group.kind !== "room" || !props.time) return;

			// на шкале "день" — ближайший час, иначе — стандартный заезд 14:00 / выезд 12:00
			const check_in = new Date(props.time);
			const check_out = new Date(props.time);
			if (this.scale === "day") {
				check_in.setMinutes(0, 0, 0);
				check_out.setTime(check_in.getTime() + DAY);
			} else {
				check_in.setHours(14, 0, 0, 0);
				check_out.setDate(check_out.getDate() + 1);
				check_out.setHours(12, 0, 0, 0);
			}

			frappe.new_doc("Room Booking", {
				room: group.id,
				check_in: format_dt(check_in),
				check_out: format_dt(check_out),
			});
		}

		set_scale(scale) {
			this.scale = scale;
			this.update_scale_buttons();
			// если «сегодня» видно — остаёмся на нём, иначе берём начало видимого периода
			const win = this.timeline.getWindow();
			const now = new Date();
			const lead = SCALES[this.scale].lead;
			this.show_period(
				now >= win.start && now <= win.end ? now : new Date(win.start.getTime() + lead)
			);
		}

		update_scale_buttons() {
			this.$body.find("[data-scale]").each((_, btn) => {
				const active = $(btn).attr("data-scale") === this.scale;
				$(btn).toggleClass("btn-primary", active).toggleClass("btn-default", !active);
			});
		}

		period_for(date) {
			const { span, lead } = SCALES[this.scale];
			const start = new Date(date);
			start.setHours(0, 0, 0, 0);
			start.setTime(start.getTime() - lead);
			return [start, new Date(start.getTime() + span)];
		}

		show_period(date) {
			const [start, end] = this.period_for(date);
			this.timeline.setWindow(start, end, { animation: false });
		}

		shift(direction) {
			const win = this.timeline.getWindow();
			const step = win.end - win.start;
			this.timeline.setWindow(
				new Date(win.start.getTime() + direction * step),
				new Date(win.end.getTime() + direction * step)
			);
		}

		update_period_label() {
			const win = this.timeline.getWindow();
			this.$body.find(".rc-timeline").toggleClass("rc-hourly", win.end - win.start <= 2 * DAY);
			const f = (d) => moment(d).format("DD.MM.YYYY");
			this.$body.find(".rc-period").text(`${f(win.start)} — ${f(win.end)}`);
		}

		available_height() {
			const el = this.$body && this.$body.find(".rc-timeline").get(0);
			const top = el ? el.getBoundingClientRect().top : 220;
			return Math.max(420, window.innerHeight - top - 56);
		}

		fit_height() {
			this.timeline && this.timeline.setOptions({ height: this.available_height() });
		}
	};

	// ---------------------------------------------------------------- helpers
	// Даты в Frappe — "наивные" строки во временной зоне системы. Разбираем их как локальное
	// время браузера и так же собираем обратно, чтобы часы на шкале совпадали с формой брони.

	function parse_dt(value) {
		const [date, time = "00:00:00"] = String(value).split(" ");
		const [y, m, d] = date.split("-").map(Number);
		const [hh, mm, ss] = time.split(":").map((v) => parseInt(v, 10) || 0);
		return new Date(y, m - 1, d, hh, mm, ss);
	}

	function format_dt(date) {
		const pad = (n) => String(n).padStart(2, "0");
		return (
			`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
			`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		);
	}

	function slug(value) {
		return String(value || "")
			.toLowerCase()
			.replace(/\s+/g, "-");
	}
})();
