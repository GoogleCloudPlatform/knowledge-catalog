import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


def create_markdown_docs():
    os.makedirs("unstructured_docs", exist_ok=True)

    # 1. Customer Profiles Specification (Markdown)
    customer_spec = """# Data Specification: Customer Profiles

## Overview
This document describes the schema, descriptions, and data classification policies for the `customers` (and `raw_customers`) tables. These tables serve as the system of record for registered user accounts.

## [NOISE] Office Cafeteria Weekly Menu
*Note: This menu is listed here for administrative convenience only. It has nothing to do with database schemas.*
- **Monday**: Margherita Pizza slice with mixed greens.
- **Tuesday (Taco Tuesday!)**: Build-your-own taco bar (Chicken, Beef, Jackfruit).
- **Wednesday**: Veggie sushi rolls and miso soup.
- **Thursday**: Homemade lasagna and garlic bread.
- **Friday**: Fish and chips or falafel wraps.
*Cafeteria hours: 11:30 AM - 2:00 PM. Please return your trays to the counter after eating.*

## Table Details
*   **Table Name**: `customers` / `raw_customers`
*   **Purpose**: Manages user profiles, credentials metadata, and contact details.

## Column Metadata and Privacy Policy

| Column Name | Data Type | Description | Policy Tag / Sensitivity |
| :--- | :--- | :--- | :--- |
| `customer_id` | STRING | Unique identifier for each customer. Generated automatically on registration. | None - Public Key |
| `name` | STRING | Full name of the customer (First Name and Last Name). | PII (Personally Identifiable Information) |
| `email` | STRING | Primary email address used for login and communications. | PII (Personally Identifiable Information) |
| `phone` | STRING | Mobile or home phone number. | PII (Personally Identifiable Information) |
| `country` | STRING | Country code of residence (ISO standard). Used for localization. | None - Low Sensitivity |
| `registration_date` | STRING | Date when the user account was created. | None |
| `card_number` | STRING | The credit card or debit card number used for billing. | PCI-DSS High Sensitivity (Requires masking) |
| `card_expiry` | STRING | Expiration date of the payment card. | PCI-DSS High Sensitivity (Requires masking) |
| `membership_level` | STRING | Customer tier status (e.g., Bronze, Silver, Gold, Platinum). | None |

## [NOISE] Lost and Found Policy
- If you find any personal items (keys, water bottles, chargers), please drop them off at the reception desk on Floor 2.
- Items unclaimed after 30 days will be donated or discarded.

## Access Control
Only authorized customer support and financial systems should have access to columns tagged as PII or PCI-DSS High Sensitivity.
"""
    with open("unstructured_docs/customer_profiles_spec.md", "w") as f:
        f.write(customer_spec)
    print("Created unstructured_docs/customer_profiles_spec.md (with noise)")

    # 2. Product Catalog Specification (Markdown)
    product_spec = """# Data Specification: Product Catalog

## Overview
This document details the public product catalog data model in the `products` and `raw_products` tables.

## [NOISE] Dublin Office Desk Booking Instructions
For hot-desking reservations in the Dublin headquarters:
1. Log in to the "Workplace Reservation Portal".
2. Select your floor (Floor 1-3).
3. Choose a green desk. Desks labeled red are reserved for permanent staff.
4. Confirm reservation. Remember to check-in via the QR code on your desk within 30 minutes of arrival.

## Table Details
*   **Table Name**: `products` / `raw_products`
*   **Purpose**: Stores active product listings, categorization, and pricing.

## Column Definitions

*   `product_id`: Unique SKU identifier for each product.
*   `name`: Commercial name of the product.
*   `category`: Product category classification (e.g., Electronics, Apparel, Home).
*   `price`: Unit price of the product in USD.

## [NOISE] Internet Commerce Trivia
*Fun Fact:* The first item ever sold on the internet was a CD of Sting's 1993 album *Ten Summoner's Tales*, purchased in August 1994 for $12.48 plus shipping.

## Security Classification
All fields in the `products` and `raw_products` tables are considered public catalog information. No policy tags or data masking rules are required.
"""
    with open("unstructured_docs/product_catalog_spec.md", "w") as f:
        f.write(product_spec)
    print("Created unstructured_docs/product_catalog_spec.md (with noise)")


def create_pdf_docs():
    pdf_path = "unstructured_docs/transaction_security_policy.pdf"
    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=letter,
        rightMargin=40,
        leftMargin=40,
        topMargin=40,
        bottomMargin=40,
    )

    styles = getSampleStyleSheet()

    # Custom Styles
    title_style = ParagraphStyle(
        "DocTitle",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=22,
        spaceAfter=15,
        textColor=colors.HexColor("#1a73e8"),
    )

    section_style = ParagraphStyle(
        "SectionHeader",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=14,
        spaceBefore=15,
        spaceAfter=10,
        textColor=colors.HexColor("#202124"),
    )

    noise_section_style = ParagraphStyle(
        "NoiseSectionHeader",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        spaceBefore=15,
        spaceAfter=8,
        textColor=colors.HexColor("#d93025"),  # Red color to highlight noise
    )

    body_style = ParagraphStyle(
        "BodyTextCustom",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        spaceAfter=8,
        textColor=colors.HexColor("#3c4043"),
    )

    table_header_style = ParagraphStyle(
        "TableHeader",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=11,
        textColor=colors.white,
    )

    table_cell_style = ParagraphStyle(
        "TableCell",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        leading=11,
        textColor=colors.HexColor("#3c4043"),
    )

    story = []

    story.append(
        Paragraph("Data Security Policy: Financial Transactions", title_style)
    )
    story.append(Spacer(1, 10))

    story.append(Paragraph("1. Overview", section_style))
    story.append(
        Paragraph(
            "This policy specifies security regulations, data governance rules, and field descriptions "
            "for the financial transactions tables (`transactions` and `raw_transactions`). These tables record "
            "all user purchases, payments, and shopping cart checkouts.",
            body_style,
        )
    )

    # Noise Paragraph 1
    story.append(
        Paragraph(
            "2. [NOISE] Office Supplies Expense Guidelines", noise_section_style
        )
    )
    story.append(
        Paragraph(
            "To request office supplies (notebooks, pens, desk lamps, monitors), submit a ticket on the IT portal. "
            "Purchases under $50 do not require pre-approval. For travel reimbursement, upload your flight receipts "
            "to the finance dashboard within 14 days of travel.",
            body_style,
        )
    )

    story.append(
        Paragraph("3. Column Specifications and Classifications", section_style)
    )
    story.append(
        Paragraph(
            "The following table defines the transaction dataset columns, their business purposes, and security rules:",
            body_style,
        )
    )

    # Table data
    data = [
        [
            Paragraph("Column Name", table_header_style),
            Paragraph("Type", table_header_style),
            Paragraph("Business Description", table_header_style),
            Paragraph("Security Classification", table_header_style),
        ],
        [
            Paragraph("transaction_id", table_cell_style),
            Paragraph("STRING", table_cell_style),
            Paragraph(
                "Primary key. Unique payment confirmation number.",
                table_cell_style,
            ),
            Paragraph("None (Public Ref)", table_cell_style),
        ],
        [
            Paragraph("order_id", table_cell_style),
            Paragraph("STRING", table_cell_style),
            Paragraph(
                "Foreign key linking the transaction to an order.",
                table_cell_style,
            ),
            Paragraph("None (Public Ref)", table_cell_style),
        ],
        [
            Paragraph("product_id", table_cell_style),
            Paragraph("STRING", table_cell_style),
            Paragraph(
                "Foreign key referencing the purchased item.", table_cell_style
            ),
            Paragraph("None (Public Ref)", table_cell_style),
        ],
        [
            Paragraph("quantity", table_cell_style),
            Paragraph("INTEGER", table_cell_style),
            Paragraph(
                "Number of units purchased in the transaction.",
                table_cell_style,
            ),
            Paragraph("None (Metric)", table_cell_style),
        ],
        [
            Paragraph("amount", table_cell_style),
            Paragraph("FLOAT", table_cell_style),
            Paragraph(
                "The financial value of the transaction in USD.",
                table_cell_style,
            ),
            Paragraph(
                "Sensitive (Requires Financial Policy Tag)", table_cell_style
            ),
        ],
    ]

    t = Table(data, colWidths=[90, 60, 230, 140])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a73e8")),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                (
                    "ROWBACKGROUNDS",
                    (0, 1),
                    (-1, -1),
                    [colors.white, colors.HexColor("#f8f9fa")],
                ),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#dadce0")),
            ]
        )
    )
    story.append(t)
    story.append(Spacer(1, 15))

    # Noise Paragraph 2
    story.append(
        Paragraph("4. [NOISE] Upcoming Office Holidays", noise_section_style)
    )
    story.append(
        Paragraph(
            "The corporate headquarters will be closed on January 1 (New Year's Day), March 17 (St. Patrick's Day), "
            "and December 25-26 (Christmas and St. Stephen's Day). Normal operations resume the following working days.",
            body_style,
        )
    )

    story.append(Paragraph("5. Audits and Enforcement", section_style))
    story.append(
        Paragraph(
            "All transactions are logged under strict financial reporting compliance. The `amount` column must be restricted "
            "to members of the Finance team and tagged appropriately to trigger column-level masking.",
            body_style,
        )
    )

    doc.build(story)
    print(
        "Created unstructured_docs/transaction_security_policy.pdf (with noise)"
    )


if __name__ == "__main__":
    create_markdown_docs()
    create_pdf_docs()
