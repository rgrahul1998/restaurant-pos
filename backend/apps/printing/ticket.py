"""Builds KOT tickets and bills as ESC/POS commands for thermal printers.

Ported from our invento_print Frappe app so paper looks the same on both systems.
The GST, round-off, merged-bill and change lines are left out: this POS has none of them.
"""

import textwrap

ESC = b"\x1b"
GS = b"\x1d"
INIT = ESC + b"@"
ALIGN_LEFT = ESC + b"a\x00"
ALIGN_CENTER = ESC + b"a\x01"
BOLD_ON = ESC + b"E\x01"
BOLD_OFF = ESC + b"E\x00"
SIZE_NORMAL = GS + b"!\x00"
SIZE_TALL = GS + b"!\x01"
SIZE_LARGE = GS + b"!\x11"
CUT = GS + b"V\x01"

QTY_COLUMN = 7
PRICE_COLUMN = 13
TYPE_TITLES = {
    "Order Modified": "ORDER MODIFIED",
    "Cancelled": "CANCELLED",
    "Partially cancelled": "PARTLY CANCELLED",
    "Duplicate": "REPRINT",
}
BILL_FOOTER = (
    "THIS IS COMPUTER GENERATED INVOICE",
    "SIGN & STAMP NOT REQUIRED",
)


def _clean(value):
    text = "" if value is None else str(value)
    return " ".join(text.split())


def _line(text=""):
    # Text comes from staff, so control characters must not reach the printer as commands.
    safe = "".join(ch if " " <= ch <= "~" else "?" for ch in str(text or ""))
    return safe.encode("ascii") + b"\n"


def _divider(width):
    return b"-" * width + b"\n"


def _row(left, right, width):
    """One line with text at both edges, or two lines when they don't fit together."""
    left, right = _clean(left), _clean(right)
    if len(left) + len(right) + 1 > width:
        return _line(left) + _line(right.rjust(width))
    return _line(left.ljust(width - len(right)) + right)


def _qty(value):
    number = float(value or 0)
    return str(int(number)) if number == int(number) else str(number)


def _money(value):
    return f"Rs.{float(value or 0):,.2f}"


def _date(value):
    parts = str(value or "").split("-")
    return "/".join(reversed(parts)) if len(parts) == 3 else _clean(value)


def _time(value):
    return str(value or "").split(".")[0]


def _customer_block(doc, width):
    output = b""
    if doc.get("customer_name"):
        output += _line(f"Name: {_clean(doc.get('customer_name'))}")
    if doc.get("mobile_number"):
        output += _line(f"Tel#: {_clean(doc.get('mobile_number'))}")
    return output


def _order_block(number, order_no, date, time, order_type, table, width):
    when = f"{_time(time)}  {_date(date)}".strip()
    output = _row(f"No: #{_clean(number)}", when, width)
    if order_no or order_type:
        output += _row(
            f"Bill No: #{_clean(order_no)}" if order_no else "", _clean(order_type), width
        )
    if table:
        output += BOLD_ON + _line(f"Table No: {_clean(table)}") + BOLD_OFF
    return output


def _kot_item_lines(item, width):
    if item.get("cancelled_qty"):
        old_qty = float(item.get("quantity") or 0)
        qty = f"{_qty(old_qty)} > {_qty(max(old_qty - float(item['cancelled_qty']), 0))}"
    else:
        qty = f"X {_qty(item.get('quantity'))}"

    column = max(QTY_COLUMN, len(qty) + 1)
    name_width = max(width - column, 1)
    names = textwrap.wrap(_clean(item.get("item_name") or item.get("item")), name_width) or [""]

    output = SIZE_TALL + BOLD_ON + _line(names[0].ljust(name_width) + qty.rjust(column))
    for extra in names[1:]:
        output += _line(extra)
    output += SIZE_NORMAL + BOLD_OFF
    for comment in textwrap.wrap(_clean(item.get("comments")), max(width - 2, 1)):
        output += _line("* " + comment)
    return output


def build_ticket(kot, width=48):
    """Return the ticket bytes. `width` is characters per line: 48 for 80mm, 32 for 58mm."""
    output = INIT + ALIGN_CENTER + SIZE_TALL + BOLD_ON + _line("KOT")
    title = TYPE_TITLES.get(kot.get("type"))
    if title:
        output += _line(title)
    output += SIZE_NORMAL + BOLD_OFF
    if kot.get("production"):
        output += _line(kot.get("production"))

    output += ALIGN_LEFT + _customer_block(kot, width) + _divider(width)

    order_type = kot.get("order_type") or (
        "Takeaway" if kot.get("table_takeaway") or not kot.get("restaurant_table") else ""
    )
    table = None if kot.get("table_takeaway") else kot.get("restaurant_table")
    output += _order_block(
        kot.get("invoice") or kot.get("name"),
        kot.get("order_no"),
        kot.get("date"),
        kot.get("time"),
        order_type,
        table,
        width,
    )
    output += _divider(width)

    output += BOLD_ON + _row("ITEM", "QTY", width) + BOLD_OFF
    for item in kot.get("kot_items") or []:
        output += _kot_item_lines(item, width)
    output += _divider(width)

    if kot.get("comments"):
        for note in textwrap.wrap(_clean(kot.get("comments")), width - 6):
            output += BOLD_ON + _line(f"Note: {note}") + BOLD_OFF
    if kot.get("user"):
        output += _line(f"By: {_clean(kot.get('user'))}")
    output += _line(_clean(kot.get("name")))

    return output + b"\n\n\n\n" + CUT


def _bill_item_lines(item, width):
    name_width = max(width - QTY_COLUMN - PRICE_COLUMN, 1)
    names = textwrap.wrap(_clean(item.get("item_name") or item.get("item_code")), name_width) or [
        ""
    ]
    output = _line(
        names[0].ljust(name_width)
        + f"X {_qty(item.get('qty'))}".rjust(QTY_COLUMN)
        + _money(item.get("amount")).rjust(PRICE_COLUMN)
    )
    for extra in names[1:]:
        output += _line(extra)
    return output


def _payment_modes(invoice):
    return ", ".join(
        _clean(p.get("mode_of_payment")) for p in invoice.get("payments") or [] if p.get("amount")
    )


def build_bill(invoice, company=None, width=48):
    """Return bill bytes. `company` is `services.company_data()`: name, address, ids, footer."""
    company = company or {}
    is_paid = invoice.get("docstatus") == 1

    output = (
        INIT
        + ALIGN_CENTER
        + SIZE_TALL
        + BOLD_ON
        + _line(_clean(company.get("name") or invoice.get("company")))
    )
    output += SIZE_NORMAL + BOLD_OFF
    lines = [company.get("legal_name"), *(company.get("address_lines") or [])]
    if company.get("phone"):
        lines.append(f"Phone: {_clean(company.get('phone'))}")
    if company.get("email"):
        lines.append(_clean(company.get("email")))
    # Not in invento_print: a registered restaurant must show these on its bills.
    if company.get("gstin"):
        lines.append(f"GSTIN: {_clean(company.get('gstin'))}")
    if company.get("fssai"):
        lines.append(f"FSSAI Lic. No: {_clean(company.get('fssai'))}")
    for line in filter(None, lines):
        for part in textwrap.wrap(_clean(line), width):
            output += _line(part)

    output += ALIGN_LEFT + _divider(width) + _customer_block(invoice, width)
    if is_paid and _payment_modes(invoice):
        output += _line(f"M.O.P: {_payment_modes(invoice)}")
    output += _divider(width)

    output += _order_block(
        invoice.get("name"),
        invoice.get("custom_ury_order_number"),
        invoice.get("posting_date"),
        invoice.get("posting_time"),
        invoice.get("order_type"),
        invoice.get("restaurant_table"),
        width,
    )
    output += _divider(width)

    name_width = max(width - QTY_COLUMN - PRICE_COLUMN, 1)
    output += (
        BOLD_ON
        + _line("ITEM".ljust(name_width) + "QTY".rjust(QTY_COLUMN) + "PRICE".rjust(PRICE_COLUMN))
        + BOLD_OFF
    )
    for item in invoice.get("items") or []:
        output += _bill_item_lines(item, width)
    output += _divider(width)

    output += _row("Item Sub Total", _money(invoice.get("total")), width)
    if invoice.get("discount_amount"):
        output += _row("Discount", "-" + _money(invoice.get("discount_amount")), width)

    grand_total = float(invoice.get("grand_total") or 0)
    output += (
        SIZE_TALL + BOLD_ON + _row("Total", _money(grand_total), width) + SIZE_NORMAL + BOLD_OFF
    )
    advance = float(invoice.get("advance_amount") or 0)
    if advance:  # paid ahead on a reservation; not in invento_print
        output += _row("Advance paid", "-" + _money(advance), width)
        if not is_paid:
            output += BOLD_ON + _row("Balance due", _money(grand_total - advance), width) + BOLD_OFF
    if is_paid:
        paid = invoice.get("paid_amount")
        output += _row("Paid", _money(paid if paid is not None else grand_total - advance), width)
    output += _divider(width)

    footer = _clean(company.get("footer", "Thank You. Visit Again."))
    if footer:
        output += ALIGN_CENTER
        for part in textwrap.wrap(footer, width):
            output += _line(part)
        output += ALIGN_LEFT + _divider(width)
    output += ALIGN_CENTER
    for line in BILL_FOOTER:
        for part in textwrap.wrap(line, width):
            output += _line(part)
    return output + b"\n\n\n\n" + CUT


def build_test_ticket(printer, width=48):
    output = INIT + ALIGN_CENTER + SIZE_LARGE + BOLD_ON + _line("TEST") + SIZE_NORMAL + BOLD_OFF
    output += _line("Printing works") + _line(printer)
    output += _divider(width)
    return output + b"\n\n\n\n" + CUT
