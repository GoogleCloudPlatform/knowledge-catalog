# Data Specification: Product Catalog

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
