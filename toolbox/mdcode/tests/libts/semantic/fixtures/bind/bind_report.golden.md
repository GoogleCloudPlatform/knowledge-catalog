# Bind report: ps_commercial (profile bigquery)

Scanned kc-demo-349204.ps_*: 33 table(s) considered, 55 dropped (listed at the end).

## Summary

| status | entities |
|---|---|
| auto | 31 |
| needs review | 2 |
| derived | 1 |
| vocabulary | 5 |
| no table | 22 |
| unbound | 0 |

Auto-accepted (bound or derived): 32 of 34 concrete entities (94%).

Data not profiled: run with --no-profile-data.

## Review

- **LegacyDeal** (needs review): no column matches key legacyDealId (guessed: opportunity_id); field coverage 0.50 < 0.60; margin 0.12 over kc-demo-349204.ps_crm.master_account_legacy < 0.15. Accepting binds `kc-demo-349204.ps_crm.deal_legacy` with key `opportunity_id`.
- **LegacyMasterAccount** (needs review): margin 0.11 over kc-demo-349204.ps_crm.client_account < 0.15. Accepting binds `kc-demo-349204.ps_crm.master_account_legacy`.

## Entities

### MarketUnit -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.39 over kc-demo-349204.ps_sales_ods.sales_target
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_crm.market_unit`: name 1.00, key matched, coverage 1.00 (4 of 4 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| currencyCode | `currency_code` | name | 1.00 |
| geographicRegion | `geographic_region` | name | 1.00 |
| unitName | `market_unit_name` | suffix | 0.80 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_sales_ods.sales_target` | 0.52 | 0.44 | yes | 0.25 |  | bound to SalesTarget |
| `kc-demo-349204.ps_crm.opportunity` | 0.50 | 0.23 | yes | 0.50 |  | bound to Opportunity |

### ServiceGroup -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.43 over kc-demo-349204.ps_crm.opportunity
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_crm.service_group`: name 1.00, key matched, coverage 1.00 (4 of 4 fields)

| field | column | rule | strength |
|---|---|---|---|
| serviceGroupCode | `service_group` | code suffix | 0.90 |
| deliveryArchetype | `delivery_archetype` | name | 1.00 |
| primaryPracticeLead | `primary_practice_lead` | name | 1.00 |
| unitName | `service_group_name` | only name column | 0.60 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.opportunity` | 0.47 | 0.14 | yes | 0.50 |  | bound to Opportunity |
| `kc-demo-349204.ps_crm.sales_credit` | 0.47 | 0.14 | yes | 0.50 |  | bound to SalesCredit |

### ClientAccount -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.37 over kc-demo-349204.ps_client_intel.client_stakeholder
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_crm.client_account`: name 1.00, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| accountId | `account_id` | name | 1.00 |
| industryVertical | `industry_vertical` | name | 1.00 |
| accountTier | `account_tier` | name | 1.00 |
| accountCreatedAt | `created_at` | entity prefix | 0.85 |
| partyName | `master_client_name` | only name column | 0.60 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.master_account_legacy` | 0.67 | 0.35 | yes | 1.00 |  | bound to LegacyMasterAccount; shadow of deprecated LegacyMasterAccount |
| `kc-demo-349204.ps_client_intel.client_stakeholder` | 0.53 | 0.43 | yes | 0.33 |  | bound to ClientStakeholder |

### EcosystemPartner -- derived

- no table of its own; its key partnerName is PartnerAlliance.partnerName (column partner_name) on relationship allianceWith: derive_from allianceWith
- best table kc-demo-349204.ps_client_intel.ecosystem_partner_alliance (score 0.66) is bound to PartnerAlliance, which scores higher on it

Hydration:

- **derive_from** `allianceWith` (from PartnerAlliance.partnerName)

Candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_client_intel.ecosystem_partner_alliance` | 0.66 | 0.67 | yes | 0.50 |  | bound to PartnerAlliance |
| `kc-demo-349204.ps_client_intel.client_stakeholder` | 0.48 | 0.15 | yes | 0.50 |  | bound to ClientStakeholder |
| `kc-demo-349204.ps_hcm.employee` | 0.48 | 0.15 | yes | 0.50 |  | bound to Employee |

### KeyBuyer -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.60 over kc-demo-349204.ps_client_intel.ecosystem_partner_alliance
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_crm.key_buyer`: name 1.00, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| accountId | `account_id` | name | 1.00 |
| buyerId | `buyer_id` | name | 1.00 |
| buyerSeniority | `seniority` | entity prefix | 0.85 |
| disposition | `disposition` | name | 1.00 |
| influenceScore | `influence_score` | name | 1.00 |
| partyName | `contact_name` | only name column | 0.60 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_client_intel.ecosystem_partner_alliance` | 0.30 | 0.13 | guessed | 0.42 |  | bound to PartnerAlliance; key guessed |
| `kc-demo-349204.ps_crm.deal_legacy` | 0.30 | 0.13 | guessed | 0.42 |  | bound to LegacyDeal; shadow of deprecated LegacyDeal; key guessed |

### ClientStakeholder -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.57 over kc-demo-349204.ps_client_intel.client_health_scorecard
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_client_intel.client_stakeholder`: name 1.00, key matched, coverage 1.00 (7 of 7 fields)

| field | column | rule | strength |
|---|---|---|---|
| accountId | `account_id` | name | 1.00 |
| stakeholderId | `stakeholder_id` | name | 1.00 |
| relationshipStance | `relationship_stance` | name | 1.00 |
| influenceLevel | `influence_level` | name | 1.00 |
| seniorityLevel | `seniority_level` | name | 1.00 |
| lastInteractionDate | `last_interaction_date` | name | 1.00 |
| partyName | `contact_name` | only name column | 0.60 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_client_intel.client_health_scorecard` | 0.33 | 0.36 | guessed | 0.21 |  | bound to ClientHealthScorecard; key guessed |
| `kc-demo-349204.ps_crm.key_buyer` | 0.28 | 0.12 | guessed | 0.36 |  | bound to KeyBuyer; key guessed |

### SalesTeamMember -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.39 over kc-demo-349204.ps_crm.sales_credit
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_crm.sales_team_member`: name 1.00, key matched, coverage 1.00 (5 of 5 fields)

| field | column | rule | strength |
|---|---|---|---|
| homeMarketUnit | `home_market_unit` | name | 1.00 |
| salesTeamMemberId | `sales_team_member_id` | name | 1.00 |
| corporateEmail | `corporate_email` | name | 1.00 |
| practitionerLevel | `practitioner_level` | name | 1.00 |
| partyName | `full_name` | only name column | 0.60 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.sales_credit` | 0.51 | 0.30 | yes | 0.40 |  | bound to SalesCredit |
| `kc-demo-349204.ps_sales_ods.sales_target` | 0.48 | 0.38 | yes | 0.20 |  | bound to SalesTarget |

### Opportunity -- auto (confidence 0.89)

- key matched, coverage 0.96, margin 0.40 over kc-demo-349204.ps_crm.sales_credit
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_crm.opportunity`: name 1.00, key matched, coverage 0.96 (14 of 14 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| serviceGroupCode | `service_group` | code suffix | 0.90 |
| accountId | `account_id` | name | 1.00 |
| opportunityId | `opportunity_id` | name | 1.00 |
| originatorId | `lead_originator_id` | label | 0.95 |
| opportunityName | `opportunity_name` | name | 1.00 |
| salesStage | `sales_stage` | name | 1.00 |
| totalContractValue | `total_contract_value` | name | 1.00 |
| annualContractValue | `annual_contract_value` | name | 1.00 |
| wonAmount | `won_amount` | name | 1.00 |
| probabilityOfWin | `probability_of_win` | name | 1.00 |
| constructType | `construct_type` | name | 1.00 |
| closeDate | `close_date` | name (type mismatch) | 0.50 |
| createdAt | `created_at` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.deal_legacy` | 0.71 | 0.45 | yes | 1.00 |  | bound to LegacyDeal; shadow of deprecated LegacyDeal |
| `kc-demo-349204.ps_crm.sales_credit` | 0.49 | 0.40 | yes | 0.21 |  | bound to SalesCredit |

### StageTransition -- auto (confidence 0.63)

- key matched, coverage 1.00, margin 0.31 over kc-demo-349204.ps_crm.sales_credit
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_crm.opportunity_stage_history`: name 0.23, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| opportunityId | `opportunity_id` | name | 1.00 |
| stageHistoryId | `stage_history_id` | name | 1.00 |
| stageName | `stage_name` | name | 1.00 |
| stageEnteredDate | `stage_entered_date` | name | 1.00 |
| daysInStage | `days_in_stage` | name | 1.00 |
| transitionedBy | `transitioned_by` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.sales_credit` | 0.32 | 0.20 | guessed | 0.42 |  | bound to SalesCredit; key guessed |
| `kc-demo-349204.ps_crm.opportunity` | 0.30 | 0.13 | guessed | 0.42 |  | bound to Opportunity; key guessed |

### SalesCredit -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.37 over kc-demo-349204.ps_hcm.staffing_assignment
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_crm.sales_credit`: name 1.00, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| serviceGroupCode | `service_group` | code suffix | 0.90 |
| salesTeamMemberId | `sales_team_member_id` | name | 1.00 |
| opportunityId | `opportunity_id` | name | 1.00 |
| roleAssignmentId | `role_assignment_id` | name | 1.00 |
| roleName | `role_name` | name | 1.00 |
| roleAllocationPct | `role_allocation_pct` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_hcm.staffing_assignment` | 0.53 | 0.43 | yes | 0.33 |  | bound to StaffingAssignment |
| `kc-demo-349204.ps_sales_ods.sales_target` | 0.40 | 0.42 | guessed | 0.42 |  | bound to SalesTarget; key guessed |

### DealPricing -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.53 over kc-demo-349204.ps_pricing.rate_card_line
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_pricing.deal_pricing`: name 1.00, key matched, coverage 1.00 (8 of 8 fields)

| field | column | rule | strength |
|---|---|---|---|
| opportunityId | `opportunity_id` | name | 1.00 |
| pricingId | `pricing_id` | name | 1.00 |
| targetPrice | `target_price` | name | 1.00 |
| floorPrice | `floor_price` | name | 1.00 |
| approvedDiscountPct | `approved_discount_pct` | name | 1.00 |
| pricingConstruct | `pricing_construct` | name | 1.00 |
| pricingStatus | `pricing_status` | name | 1.00 |
| pricingCreatedAt | `created_at` | entity prefix | 0.85 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_pricing.rate_card_line` | 0.38 | 0.13 | yes | 0.13 |  | bound to RateCardLine |
| `kc-demo-349204.ps_pricing.pricing_dispute` | 0.37 | 0.49 | guessed | 0.19 |  | bound to PricingDispute; key guessed |

### RateCardLine -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.53 over kc-demo-349204.ps_pricing.price_adjustment
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_pricing.rate_card_line`: name 1.00, key matched, coverage 1.00 (7 of 7 fields)

| field | column | rule | strength |
|---|---|---|---|
| pricingId | `pricing_id` | name | 1.00 |
| rateLineId | `rate_line_id` | name | 1.00 |
| roleLevel | `role_level` | name | 1.00 |
| country | `country` | name | 1.00 |
| averageDailyRate | `average_daily_rate` | name | 1.00 |
| hoursAssumed | `hours_assumed` | name | 1.00 |
| billingUnit | `billing_unit` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_pricing.price_adjustment` | 0.37 | 0.10 | yes | 0.14 |  | bound to PriceAdjustment |
| `kc-demo-349204.ps_pricing.deal_pricing` | 0.25 | 0.13 | guessed | 0.21 |  | bound to DealPricing; key guessed |

### PricingDispute -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.59 over kc-demo-349204.ps_pricing.deal_pricing
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_pricing.pricing_dispute`: name 1.00, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| opportunityId | `opportunity_id` | name | 1.00 |
| disputeId | `dispute_id` | name | 1.00 |
| disputeStatus | `dispute_status` | name | 1.00 |
| escalationTier | `escalation_tier` | name | 1.00 |
| loggedAt | `logged_at` | name | 1.00 |
| resolvedAt | `resolved_at` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_pricing.deal_pricing` | 0.31 | 0.27 | guessed | 0.25 |  | bound to DealPricing; key guessed |
| `kc-demo-349204.ps_crm.opportunity_stage_history` | 0.26 | 0.13 | guessed | 0.25 |  | bound to StageTransition; key guessed |

### PartnerAlliance -- auto (confidence 0.78)

- key matched, coverage 1.00, margin 0.50 over kc-demo-349204.ps_delivery.engagement
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_client_intel.ecosystem_partner_alliance`: name 0.65, key matched, coverage 1.00 (7 of 7 fields)

| field | column | rule | strength |
|---|---|---|---|
| accountId | `account_id` | name | 1.00 |
| partnerName | `partner_name` | name | 1.00 |
| allianceId | `alliance_id` | name | 1.00 |
| partnerTier | `partner_tier` | name | 1.00 |
| jointPipelineUsd | `joint_pipeline_usd` | name | 1.00 |
| allianceRevenueInfluence | `alliance_revenue_influence` | name | 1.00 |
| subcontractorUsed | `subcontractor_used` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.deal_legacy` | 0.30 | 0.17 | guessed | 0.36 |  | bound to LegacyDeal; shadow of deprecated LegacyDeal; key guessed |
| `kc-demo-349204.ps_delivery.engagement` | 0.27 | 0.10 | guessed | 0.36 |  | bound to Engagement; key guessed |

### ClientHealthScorecard -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.58 over kc-demo-349204.ps_client_intel.client_stakeholder
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_client_intel.client_health_scorecard`: name 1.00, key matched, coverage 1.00 (8 of 8 fields)

| field | column | rule | strength |
|---|---|---|---|
| accountId | `account_id` | name | 1.00 |
| scorecardId | `scorecard_id` | name | 1.00 |
| npsScore | `nps_score` | name | 1.00 |
| sentimentCategory | `sentiment_category` | name | 1.00 |
| relationshipHealthIndex | `relationship_health_index` | name | 1.00 |
| surveyDate | `survey_date` | name | 1.00 |
| advocacyRating | `advocacy_rating` | name | 1.00 |
| surveyPeriod | `survey_period` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_client_intel.client_stakeholder` | 0.32 | 0.36 | guessed | 0.19 |  | bound to ClientStakeholder; key guessed |
| `kc-demo-349204.ps_market.intent_signal` | 0.26 | 0.17 | guessed | 0.19 |  | bound to IntentSignal; key guessed |

### PriceAdjustment -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.57 over kc-demo-349204.ps_pricing.rate_card_line
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_pricing.price_adjustment`: name 1.00, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| rateLineId | `rate_line_id` | name | 1.00 |
| adjustmentId | `adjustment_id` | name | 1.00 |
| adjustmentReason | `adjustment_reason` | name | 1.00 |
| adjustmentPct | `adjustment_pct` | name | 1.00 |
| approverName | `approver_name` | name | 1.00 |
| approvedDate | `approved_date` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_pricing.rate_card_line` | 0.33 | 0.34 | guessed | 0.25 |  | bound to RateCardLine; key guessed |
| `kc-demo-349204.ps_crm.master_account_legacy` | 0.28 | 0.18 | guessed | 0.25 |  | bound to LegacyMasterAccount; shadow of deprecated LegacyMasterAccount; key guessed |

### SalesTarget -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.52 over kc-demo-349204.ps_crm.sales_credit
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_sales_ods.sales_target`: name 1.00, key matched, coverage 1.00 (7 of 7 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| serviceGroupCode | `service_group` | code suffix | 0.90 |
| salesTeamMemberId | `sales_team_member_id` | name | 1.00 |
| targetId | `target_id` | name | 1.00 |
| fiscalYear | `fiscal_year` | name | 1.00 |
| contributionTargetAmount | `contribution_target_amount` | name | 1.00 |
| craftContributionTargetAmount | `craft_contribution_target_amount` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.sales_credit` | 0.39 | 0.42 | guessed | 0.36 |  | bound to SalesCredit; key guessed |
| `kc-demo-349204.ps_finance.revenue_actual` | 0.28 | 0.12 | guessed | 0.36 |  | bound to RevenueActual; key guessed |

### PipelineSnapshot -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.75 over kc-demo-349204.ps_market.industry_forecast
- table `kc-demo-349204.ps_sales_ods.pipeline_snapshot`: name 1.00, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| serviceGroupCode | `service_group` | code suffix | 0.90 |
| asOfDate | `as_of_date` | name | 1.00 |
| forecastCategory | `forecast_category` | name | 1.00 |
| pipelineValue | `pipeline_value` | name | 1.00 |
| weightedPipelineValue | `weighted_pipeline_value` | name | 1.00 |

### IntentSignal -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.59 over kc-demo-349204.ps_market.industry_forecast
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_market.intent_signal`: name 1.00, key matched, coverage 1.00 (10 of 10 fields)

| field | column | rule | strength |
|---|---|---|---|
| accountId | `account_id` | name | 1.00 |
| signalId | `signal_id` | name | 1.00 |
| intentTopic | `intent_topic` | name | 1.00 |
| surgeScore | `surge_score` | name | 1.00 |
| techInstallCount | `tech_install_count` | name | 1.00 |
| signalDate | `signal_date` | name | 1.00 |
| sourceFeed | `source_feed` | name | 1.00 |
| sourceOfRecord | `source_of_record` | name | 1.00 |
| genaiUsageRights | `genai_usage_rights` | name | 1.00 |
| syntheticProxy | `synthetic_proxy` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_market.industry_forecast` | 0.31 | 0.13 | guessed | 0.45 |  | bound to IndustryForecast; key guessed |
| `kc-demo-349204.ps_client_intel.client_health_scorecard` | 0.25 | 0.17 | guessed | 0.15 |  | bound to ClientHealthScorecard; key guessed |

### IndustryForecast -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.61 over kc-demo-349204.ps_market.intent_signal
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_market.industry_forecast`: name 1.00, key matched, coverage 1.00 (12 of 12 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| serviceGroupCode | `service_group` | code suffix | 0.90 |
| forecastId | `forecast_id` | name | 1.00 |
| marketVertical | `market_vertical` | name | 1.00 |
| forecastYear | `forecast_year` | name | 1.00 |
| totalAddressableMarketUsd | `total_addressable_market_usd` | name | 1.00 |
| tamGrowthPct | `tam_growth_pct` | name | 1.00 |
| cloudMigrationSpendUsd | `cloud_migration_spend_usd` | name | 1.00 |
| sourceFeed | `source_feed` | name | 1.00 |
| sourceOfRecord | `source_of_record` | name | 1.00 |
| genaiUsageRights | `genai_usage_rights` | name | 1.00 |
| syntheticProxy | `synthetic_proxy` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_market.intent_signal` | 0.29 | 0.13 | guessed | 0.38 |  | bound to IntentSignal; key guessed |
| `kc-demo-349204.ps_sales_ods.sales_target` | 0.27 | 0.18 | guessed | 0.21 |  | bound to SalesTarget; key guessed |

### LegacyDeal -- needs review (confidence 0.48)

Deprecated; use Opportunity.

- no column matches key legacyDealId (guessed: opportunity_id)
- field coverage 0.50 < 0.60
- margin 0.12 over kc-demo-349204.ps_crm.master_account_legacy < 0.15
- table `kc-demo-349204.ps_crm.deal_legacy`: name 0.60, key guessed, coverage 0.50 (1 of 1 fields)

| field | column | rule | strength |
|---|---|---|---|
| legacyDealId | `opportunity_id` | first _id column (guessed) | 0.30 |

Candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.deal_legacy` | 0.48 | 0.60 | guessed | 0.50 |  | chosen; key guessed |
| `kc-demo-349204.ps_crm.master_account_legacy` | 0.36 | 0.26 | guessed | 0.50 |  | bound to LegacyMasterAccount; key guessed |
| `kc-demo-349204.ps_pricing.deal_pricing` | 0.35 | 0.21 | guessed | 0.50 |  | bound to DealPricing; key guessed |

### LegacyMasterAccount -- needs review (confidence 0.79)

Deprecated; use ClientAccount.

- margin 0.11 over kc-demo-349204.ps_crm.client_account < 0.15
- table `kc-demo-349204.ps_crm.master_account_legacy`: name 0.68, key matched, coverage 1.00 (1 of 1 fields)

| field | column | rule | strength |
|---|---|---|---|
| legacyAccountId | `account_id` | entity prefix | 0.85 |

Candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_crm.master_account_legacy` | 0.79 | 0.68 | yes | 1.00 |  | chosen |
| `kc-demo-349204.ps_crm.client_account` | 0.68 | 0.36 | yes | 1.00 |  | bound to ClientAccount |
| `kc-demo-349204.ps_crm.deal_legacy` | 0.64 | 0.26 | yes | 1.00 |  | bound to LegacyDeal |

### ContractAgreement -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.41 over kc-demo-349204.ps_contracts.contract_obligation
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_contracts.contract_agreement`: name 1.00, key matched, coverage 1.00 (11 of 11 fields)

| field | column | rule | strength |
|---|---|---|---|
| accountId | `account_id` | name | 1.00 |
| opportunityId | `opportunity_id` | name | 1.00 |
| contractNumber | `contract_number` | name | 1.00 |
| contractName | `contract_name` | name | 1.00 |
| contractType | `contract_type` | name | 1.00 |
| contractStatus | `contract_status` | name | 1.00 |
| contractStartDate | `start_date` | entity prefix | 0.85 |
| contractEndDate | `end_date` | entity prefix | 0.85 |
| governingLaw | `governing_law` | name | 1.00 |
| liabilityCapUsd | `liability_cap_usd` | name | 1.00 |
| totalCommittedValue | `total_committed_value` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_contracts.contract_obligation` | 0.49 | 0.47 | yes | 0.09 |  | bound to ContractObligation |
| `kc-demo-349204.ps_delivery.engagement` | 0.47 | 0.23 | yes | 0.36 |  | bound to Engagement |

### ChangeOrder -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.56 over kc-demo-349204.ps_contracts.contract_obligation
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_contracts.change_order`: name 1.00, key matched, coverage 1.00 (8 of 8 fields)

| field | column | rule | strength |
|---|---|---|---|
| contractNumber | `contract_number` | name | 1.00 |
| changeOrderId | `change_order_id` | name | 1.00 |
| ccnNumber | `ccn_number` | name | 1.00 |
| changeType | `change_type` | name | 1.00 |
| changeStatus | `change_status` | name | 1.00 |
| effectiveDate | `effective_date` | name | 1.00 |
| valueDeltaUsd | `value_delta_usd` | name | 1.00 |
| hoursDelta | `hours_delta` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_contracts.contract_obligation` | 0.34 | 0.40 | guessed | 0.19 |  | bound to ContractObligation; key guessed |
| `kc-demo-349204.ps_contracts.contract_agreement` | 0.33 | 0.38 | guessed | 0.19 |  | bound to ContractAgreement; key guessed |

### ContractObligation -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.54 over kc-demo-349204.ps_contracts.contract_agreement
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_contracts.contract_obligation`: name 1.00, key matched, coverage 1.00 (6 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| contractNumber | `contract_number` | name | 1.00 |
| obligationId | `obligation_id` | name | 1.00 |
| obligationTitle | `obligation_title` | name | 1.00 |
| obligationCategory | `obligation_category` | name | 1.00 |
| penaltyClause | `penalty_clause` | name | 1.00 |
| slaThresholdPct | `sla_threshold_pct` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_contracts.contract_agreement` | 0.36 | 0.43 | guessed | 0.25 |  | bound to ContractAgreement; key guessed |
| `kc-demo-349204.ps_delivery.engagement` | 0.24 | 0.08 | guessed | 0.25 |  | bound to Engagement; key guessed |

### Engagement -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.50 over kc-demo-349204.ps_hcm.staffing_assignment
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_delivery.engagement`: name 1.00, key matched, coverage 1.00 (12 of 12 fields)

| field | column | rule | strength |
|---|---|---|---|
| accountId | `account_id` | name | 1.00 |
| opportunityId | `opportunity_id` | name | 1.00 |
| contractNumber | `contract_number` | name | 1.00 |
| engagementId | `engagement_id` | name | 1.00 |
| deliveryLeadId | `delivery_lead_id` | name | 1.00 |
| engagementName | `engagement_name` | name | 1.00 |
| deliveryMethod | `delivery_method` | name | 1.00 |
| healthStatus | `health_status` | name | 1.00 |
| plannedEffortHours | `planned_effort_hours` | name | 1.00 |
| actualEffortHours | `actual_effort_hours` | name | 1.00 |
| etcEffortHours | `etc_effort_hours` | name | 1.00 |
| eacMarginPct | `eac_margin_pct` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_hcm.staffing_assignment` | 0.40 | 0.22 | yes | 0.08 |  | bound to StaffingAssignment |
| `kc-demo-349204.ps_delivery.milestone` | 0.38 | 0.11 | yes | 0.17 |  | bound to Milestone |

### Milestone -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.64 over kc-demo-349204.ps_hcm.timesheet_entry
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_delivery.milestone`: name 1.00, key matched, coverage 1.00 (8 of 8 fields)

| field | column | rule | strength |
|---|---|---|---|
| engagementId | `engagement_id` | name | 1.00 |
| milestoneId | `delivery_milestone_id` | suffix | 0.80 |
| milestoneName | `milestone_name` | name | 1.00 |
| milestoneType | `milestone_type` | name | 1.00 |
| baselineDate | `baseline_date` | name | 1.00 |
| forecastDate | `forecast_date` | name | 1.00 |
| completionStatus | `completion_status` | name | 1.00 |
| delayDays | `delay_days` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_hcm.timesheet_entry` | 0.26 | 0.18 | guessed | 0.19 |  | bound to TimesheetEntry; key guessed |
| `kc-demo-349204.ps_pricing.price_adjustment` | 0.26 | 0.17 | guessed | 0.19 |  | bound to PriceAdjustment; key guessed |

### QAHealthCheck -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.62 over kc-demo-349204.ps_client_intel.client_health_scorecard
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_delivery.qa_healthcheck`: name 1.00, key matched, coverage 1.00 (8 of 8 fields)

| field | column | rule | strength |
|---|---|---|---|
| engagementId | `engagement_id` | name | 1.00 |
| healthcheckId | `healthcheck_id` | name | 1.00 |
| checkDate | `check_date` | name | 1.00 |
| checkType | `check_type` | name | 1.00 |
| qaScore | `qa_score` | name | 1.00 |
| riskLevel | `risk_level` | name | 1.00 |
| openDefectsCount | `open_defects_count` | name | 1.00 |
| criticalRisksCount | `critical_risks_count` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_client_intel.client_health_scorecard` | 0.28 | 0.31 | guessed | 0.06 |  | bound to ClientHealthScorecard; key guessed |
| `kc-demo-349204.ps_delivery.milestone` | 0.24 | 0.12 | guessed | 0.19 |  | bound to Milestone; key guessed |

### Employee -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.52 over kc-demo-349204.ps_hcm.staffing_assignment
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_hcm.employee`: name 1.00, key matched, coverage 1.00 (9 of 9 fields)

| field | column | rule | strength |
|---|---|---|---|
| homeMarketUnit | `home_market_unit` | name | 1.00 |
| employeeId | `employee_id` | name | 1.00 |
| workEmail | `work_email` | name | 1.00 |
| careerTrack | `career_track` | name | 1.00 |
| standardLevel | `standard_level` | name | 1.00 |
| baseDailyCost | `base_daily_cost` | name | 1.00 |
| utilizationTargetPct | `utilization_target_pct` | name | 1.00 |
| isActive | `is_active` | name | 1.00 |
| partyName | `full_name` | only name column | 0.60 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_hcm.staffing_assignment` | 0.38 | 0.14 | yes | 0.11 |  | bound to StaffingAssignment |
| `kc-demo-349204.ps_hcm.timesheet_entry` | 0.36 | 0.11 | yes | 0.11 |  | bound to TimesheetEntry |

### StaffingAssignment -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.47 over kc-demo-349204.ps_hcm.timesheet_entry
- table `kc-demo-349204.ps_hcm.staffing_assignment`: name 1.00, key matched, coverage 1.00 (8 of 8 fields)

| field | column | rule | strength |
|---|---|---|---|
| engagementId | `engagement_id` | name | 1.00 |
| employeeId | `employee_id` | name | 1.00 |
| assignmentId | `assignment_id` | name | 1.00 |
| assignedRole | `assigned_role` | name | 1.00 |
| assignmentStartDate | `start_date` | entity prefix | 0.85 |
| assignmentEndDate | `end_date` | entity prefix | 0.85 |
| allocationPct | `allocation_pct` | name | 1.00 |
| scheduledHours | `scheduled_hours` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_hcm.timesheet_entry` | 0.43 | 0.11 | yes | 0.38 |  | bound to TimesheetEntry |
| `kc-demo-349204.ps_crm.sales_credit` | 0.40 | 0.11 | yes | 0.25 |  | bound to SalesCredit |

### TimesheetEntry -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.65 over kc-demo-349204.ps_delivery.milestone
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_hcm.timesheet_entry`: name 1.00, key matched, coverage 1.00 (9 of 9 fields)

| field | column | rule | strength |
|---|---|---|---|
| engagementId | `engagement_id` | name | 1.00 |
| employeeId | `employee_id` | name | 1.00 |
| assignmentId | `assignment_id` | name | 1.00 |
| timesheetId | `timesheet_id` | name | 1.00 |
| workDate | `work_date` | name | 1.00 |
| entryStatus | `entry_status` | name | 1.00 |
| billableHours | `billable_hours` | name | 1.00 |
| nonBillableHours | `non_billable_hours` | name | 1.00 |
| overtimeHours | `overtime_hours` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_delivery.milestone` | 0.25 | 0.18 | guessed | 0.17 |  | bound to Milestone; key guessed |
| `kc-demo-349204.ps_delivery.engagement` | 0.24 | 0.14 | guessed | 0.17 |  | bound to Engagement; key guessed |

### WBSElement -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.50 over kc-demo-349204.ps_finance.revenue_actual
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_finance.wbs_element`: name 1.00, key matched, coverage 1.00 (8 of 8 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| opportunityId | `opportunity_id` | name | 1.00 |
| wbsElementCode | `wbs_element` | label | 0.95 |
| companyCode | `company_code` | name | 1.00 |
| legalEntity | `legal_entity` | name | 1.00 |
| recognitionMethod | `recognition_method` | name | 1.00 |
| contractValueUsd | `contract_value_usd` | name | 1.00 |
| setupDate | `setup_date` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_finance.revenue_actual` | 0.40 | 0.12 | yes | 0.25 |  | bound to RevenueActual |
| `kc-demo-349204.ps_finance.booking` | 0.40 | 0.10 | yes | 0.25 |  | bound to Booking |

### RevenueActual -- auto (confidence 0.90)

- key matched, coverage 1.00, margin 0.64 over kc-demo-349204.ps_finance.wbs_element
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- table `kc-demo-349204.ps_finance.revenue_actual`: name 1.00, key matched, coverage 1.00 (9 of 9 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| serviceGroupCode | `service_group` | code suffix | 0.90 |
| wbsElementCode | `wbs_element` | label | 0.95 |
| revenueEntryId | `revenue_entry_id` | name | 1.00 |
| servicesRevenue | `services_revenue` | name | 1.00 |
| allianceUtilizationRevenue | `alliance_utilization_revenue` | name | 1.00 |
| softwareMiscRevenue | `software_misc_revenue` | name | 1.00 |
| costToServe | `cost_to_serve` | name | 1.00 |
| recognizedPeriod | `recognized_period` | name | 1.00 |

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_finance.wbs_element` | 0.26 | 0.12 | guessed | 0.28 |  | bound to WBSElement; key guessed |
| `kc-demo-349204.ps_crm.deal_legacy` | 0.26 | 0.12 | guessed | 0.28 |  | bound to LegacyDeal; shadow of deprecated LegacyDeal; key guessed |

### Booking -- auto (confidence 0.86)

- key matched, coverage 0.83, margin 0.57 over kc-demo-349204.ps_finance.wbs_element
- not bound to kc-demo-349204.ps_crm.master_account_legacy: looks more like deprecated LegacyMasterAccount
- not bound to kc-demo-349204.ps_crm.deal_legacy: looks more like deprecated LegacyDeal
- table `kc-demo-349204.ps_finance.booking`: name 1.00, key matched, coverage 0.83 (5 of 6 fields)

| field | column | rule | strength |
|---|---|---|---|
| marketUnitCode | `market_unit` | code suffix | 0.90 |
| wbsElementCode | `wbs_element` | label | 0.95 |
| bookingId | `booking_id` | name | 1.00 |
| signDate | `sign_date` | name | 1.00 |
| authorizedBy | `authorized_by` | name | 1.00 |

Unbound fields: bookedAmount.

Rejected candidates:

| table | score | name | key | coverage | KC | note |
|---|---|---|---|---|---|---|
| `kc-demo-349204.ps_finance.wbs_element` | 0.29 | 0.10 | guessed | 0.42 |  | bound to WBSElement; key guessed |
| `kc-demo-349204.ps_finance.revenue_actual` | 0.25 | 0.00 | guessed | 0.42 |  | bound to RevenueActual; key guessed |

## Vocabularies

### GeographicRegion -- vocabulary

- a vocabulary: bound to its generated view vocab_geographic_region (code, label, sort_order, definition, iri); no source

### SalesStage -- vocabulary

- a vocabulary: bound to its generated view vocab_sales_stage (code, label, sort_order, definition, iri); no source

View columns: stageLabel -> `label`, stageOrder -> `sort_order`.

### PricingConstruct -- vocabulary

- a vocabulary: bound to its generated view vocab_pricing_construct (code, label, sort_order, definition, iri); no source

### ContractStatus -- vocabulary

- a vocabulary: bound to its generated view vocab_contract_status (code, label, sort_order, definition, iri); no source

### HealthStatus -- vocabulary

- a vocabulary: bound to its generated view vocab_health_status (code, label, sort_order, definition, iri); no source

## No table

| entity | kind | why |
|---|---|---|
| BusinessObject | abstract | abstract: grouped by its subtypes, no table |
| Party | abstract | abstract: grouped by its subtypes, no table |
| Organization | abstract | abstract: grouped by its subtypes, no table |
| Person | abstract | abstract: grouped by its subtypes, no table |
| OrgUnit | abstract | abstract: grouped by its subtypes, no table |
| CommercialDocument | abstract | abstract: grouped by its subtypes, no table |
| Agreement | abstract | abstract: grouped by its subtypes, no table |
| WonOpportunity | defined | defined: a filter over ClosedOpportunity, no table |
| LostOpportunity | defined | defined: a filter over ClosedOpportunity, no table |
| ClosedOpportunity | defined | defined: a filter over Opportunity, no table |
| ActivePipeline | defined | defined: a filter over Opportunity, no table |
| HighValueOpportunity | defined | defined: a filter over Opportunity, no table |
| MegaDeal | defined | defined: a filter over HighValueOpportunity, no table |
| StrategicAccount | defined | defined: a filter over ClientAccount, no table |
| PriorityOpportunity | abstract | abstract: grouped by its subtypes, no table |
| MarketIntelligenceRecord | abstract | abstract: grouped by its subtypes, no table |
| MasterServicesAgreement | defined | defined: a filter over ContractAgreement, no table |
| StatementOfWork | defined | defined: a filter over ContractAgreement, no table |
| Subcontract | defined | defined: a filter over ContractAgreement, no table |
| Amendment | defined | defined: a filter over ContractAgreement, no table |
| QAAssuredEngagement | abstract | abstract: grouped by its subtypes, no table |
| AtRiskEngagement | defined | defined: a filter over Engagement, no table |

## Relationships

| relationship | from | to | foreign key | profile | hydration |
|---|---|---|---|---|---|
| inRegion | MarketUnit | GeographicRegion | `geographic_region` |  |  |
| inStage | Opportunity | SalesStage | `sales_stage` |  |  |
| pricedOn | DealPricing | PricingConstruct | `pricing_construct` |  |  |
| hasBuyer | Opportunity | ClientAccount | `account_id` |  |  |
| bookedIn | Opportunity | MarketUnit | `market_unit` |  |  |
| soldBy | Opportunity | ServiceGroup | `service_group` |  |  |
| originatedBy | Opportunity | SalesTeamMember | `lead_originator_id` |  |  |
| managedIn | ClientAccount | MarketUnit | `market_unit` |  |  |
| buyerAt | KeyBuyer | ClientAccount | `account_id` |  |  |
| stakeholderAt | ClientStakeholder | ClientAccount | `account_id` |  |  |
| sellerHomeMarket | SalesTeamMember | MarketUnit | `home_market_unit` |  |  |
| transitionOf | StageTransition | Opportunity | `opportunity_id` |  |  |
| creditedOn | SalesCredit | Opportunity | `opportunity_id` |  |  |
| creditedTo | SalesCredit | SalesTeamMember | `sales_team_member_id` |  |  |
| creditedServiceGroup | SalesCredit | ServiceGroup | `service_group` |  |  |
| prices | DealPricing | Opportunity | `opportunity_id` |  |  |
| lineOf | RateCardLine | DealPricing | `pricing_id` |  |  |
| disputes | PricingDispute | Opportunity | `opportunity_id` |  |  |
| allianceWith | PartnerAlliance | EcosystemPartner | `partner_name` |  |  |
| allianceFor | PartnerAlliance | ClientAccount | `account_id` |  |  |
| scorecardOf | ClientHealthScorecard | ClientAccount | `account_id` |  |  |
| adjusts | PriceAdjustment | RateCardLine | `rate_line_id` |  |  |
| targetOf | SalesTarget | SalesTeamMember | `sales_team_member_id` |  |  |
| targetInMarket | SalesTarget | MarketUnit | `market_unit` |  |  |
| targetForServiceGroup | SalesTarget | ServiceGroup | `service_group` |  |  |
| snapshotInMarket | PipelineSnapshot | MarketUnit | `market_unit` |  |  |
| snapshotForServiceGroup | PipelineSnapshot | ServiceGroup | `service_group` |  |  |
| signalFor | IntentSignal | ClientAccount | `account_id` |  |  |
| forecastForMarket | IndustryForecast | MarketUnit | `market_unit` |  |  |
| forecastForServiceGroup | IndustryForecast | ServiceGroup | `service_group` |  |  |
| hasStatus | ContractAgreement | ContractStatus | `contract_status` |  |  |
| contractFor | ContractAgreement | Opportunity | `opportunity_id` |  |  |
| amends | ChangeOrder | ContractAgreement | `contract_number` |  |  |
| obligationOf | ContractObligation | ContractAgreement | `contract_number` |  |  |
| hasHealth | Engagement | HealthStatus | `health_status` |  |  |
| delivers | Engagement | Opportunity | `opportunity_id` |  |  |
| executes | Engagement | ContractAgreement | `contract_number` |  |  |
| ledBy | Engagement | SalesTeamMember | `delivery_lead_id` |  |  |
| milestoneOf | Milestone | Engagement | `engagement_id` |  |  |
| checks | QAHealthCheck | Engagement | `engagement_id` |  |  |
| staffedOn | StaffingAssignment | Engagement | `engagement_id` |  |  |
| assignee | StaffingAssignment | Employee | `employee_id` |  |  |
| recordedAgainst | TimesheetEntry | StaffingAssignment | `assignment_id` |  |  |
| employeeHomeMarket | Employee | MarketUnit | `home_market_unit` |  |  |
| deliveredFor | Engagement | ClientAccount | `account_id` |  |  |
| recordedBy | TimesheetEntry | Employee | `employee_id` |  |  |
| recordedOn | TimesheetEntry | Engagement | `engagement_id` |  |  |
| hasPayer | ContractAgreement | ClientAccount | `account_id` |  |  |
| financesOpportunity | WBSElement | Opportunity | `opportunity_id` |  |  |
| postedTo | RevenueActual | WBSElement | `wbs_element` |  |  |
| bookedOn | Booking | WBSElement | `wbs_element` |  |  |
| wbsInMarket | WBSElement | MarketUnit | `market_unit` |  |  |
| revenueInMarket | RevenueActual | MarketUnit | `market_unit` |  |  |
| revenueForServiceGroup | RevenueActual | ServiceGroup | `service_group` |  |  |
| bookingInMarket | Booking | MarketUnit | `market_unit` |  |  |

## Dropped tables

- `ps_semantic.booking`: dataset excluded (ps_semantic)
- `ps_semantic.change_order`: dataset excluded (ps_semantic)
- `ps_semantic.client_account`: dataset excluded (ps_semantic)
- `ps_semantic.client_health_scorecard`: dataset excluded (ps_semantic)
- `ps_semantic.client_stakeholder`: dataset excluded (ps_semantic)
- `ps_semantic.cls_active_pipeline`: dataset excluded (ps_semantic)
- `ps_semantic.cls_amendment`: dataset excluded (ps_semantic)
- `ps_semantic.cls_at_risk_engagement`: dataset excluded (ps_semantic)
- `ps_semantic.cls_closed_opportunity`: dataset excluded (ps_semantic)
- `ps_semantic.cls_high_value_opportunity`: dataset excluded (ps_semantic)
- `ps_semantic.cls_lost_opportunity`: dataset excluded (ps_semantic)
- `ps_semantic.cls_master_services_agreement`: dataset excluded (ps_semantic)
- `ps_semantic.cls_mega_deal`: dataset excluded (ps_semantic)
- `ps_semantic.cls_priority_opportunity`: dataset excluded (ps_semantic)
- `ps_semantic.cls_qa_assured_engagement`: dataset excluded (ps_semantic)
- `ps_semantic.cls_statement_of_work`: dataset excluded (ps_semantic)
- `ps_semantic.cls_strategic_account`: dataset excluded (ps_semantic)
- `ps_semantic.cls_subcontract`: dataset excluded (ps_semantic)
- `ps_semantic.cls_won_opportunity`: dataset excluded (ps_semantic)
- `ps_semantic.contract_agreement`: dataset excluded (ps_semantic)
- `ps_semantic.contract_obligation`: dataset excluded (ps_semantic)
- `ps_semantic.deal_pricing`: dataset excluded (ps_semantic)
- `ps_semantic.ecosystem_partner`: dataset excluded (ps_semantic)
- `ps_semantic.employee`: dataset excluded (ps_semantic)
- `ps_semantic.engagement`: dataset excluded (ps_semantic)
- `ps_semantic.geographic_region`: dataset excluded (ps_semantic)
- `ps_semantic.industry_forecast`: dataset excluded (ps_semantic)
- `ps_semantic.intent_signal`: dataset excluded (ps_semantic)
- `ps_semantic.key_buyer`: dataset excluded (ps_semantic)
- `ps_semantic.legacy_deal`: dataset excluded (ps_semantic)
- `ps_semantic.legacy_master_account`: dataset excluded (ps_semantic)
- `ps_semantic.lookup_market_unit_key`: dataset excluded (ps_semantic)
- `ps_semantic.lookup_service_group_key`: dataset excluded (ps_semantic)
- `ps_semantic.market_unit`: dataset excluded (ps_semantic)
- `ps_semantic.milestone`: dataset excluded (ps_semantic)
- `ps_semantic.opportunity`: dataset excluded (ps_semantic)
- `ps_semantic.opportunity_stage_history`: dataset excluded (ps_semantic)
- `ps_semantic.partner_alliance`: dataset excluded (ps_semantic)
- `ps_semantic.pipeline_snapshot`: dataset excluded (ps_semantic)
- `ps_semantic.price_adjustment`: dataset excluded (ps_semantic)
- `ps_semantic.pricing_dispute`: dataset excluded (ps_semantic)
- `ps_semantic.qa_healthcheck`: dataset excluded (ps_semantic)
- `ps_semantic.rate_card_line`: dataset excluded (ps_semantic)
- `ps_semantic.revenue_actual`: dataset excluded (ps_semantic)
- `ps_semantic.sales_credit`: dataset excluded (ps_semantic)
- `ps_semantic.sales_target`: dataset excluded (ps_semantic)
- `ps_semantic.sales_team_member`: dataset excluded (ps_semantic)
- `ps_semantic.service_group`: dataset excluded (ps_semantic)
- `ps_semantic.staffing_assignment`: dataset excluded (ps_semantic)
- `ps_semantic.timesheet_entry`: dataset excluded (ps_semantic)
- `ps_semantic.vocab_contract_status`: dataset excluded (ps_semantic)
- `ps_semantic.vocab_health_status`: dataset excluded (ps_semantic)
- `ps_semantic.vocab_pricing_construct`: dataset excluded (ps_semantic)
- `ps_semantic.vocab_sales_stage`: dataset excluded (ps_semantic)
- `ps_semantic.wbs_element`: dataset excluded (ps_semantic)
