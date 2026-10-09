# Data Specification: Customer Profiles

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
