# Ifmis Purchase Order Change Retrieval Out — Detailed Flow Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Glossary & Key Terminology](#2-glossary--key-terminology)
3. [Architecture & Technology Stack](#3-architecture--technology-stack)
    - [Key Classes](#key-classes)
    - [Additional Details](#additional-details)
4. [Configuration & Environment Variables](#4-configuration--environment-variables)
    - [Application Server](#application-server)
    - [Database](#database)
    - [File Generation](#file-generation)
5. [Application Startup](#5-application-startup)
6. [Authentication — Token API](#6-authentication--token-api)
    - [Database Authentication](#database-authentication)
    - [Authentication Flow](#authentication-flow)
    - [Security Considerations](#security-considerations)
7. [Purchase Order Change Processing Flow](#7-purchase-order-change-processing-flow)
    - [Step 1: Application Startup and Command-Line Argument Parsing](#step-1-application-startup-and-command-line-argument-parsing)
    - [Step 2: Batch Processing of Purchase Order Changes](#step-2-batch-processing-of-purchase-order-changes)
    - [Step 3: Retrieve Purchase Order Headers](#step-3-retrieve-purchase-order-headers)
    - [Step 4: Prepare EDI Model and Generate Delimited File](#step-4-prepare-edi-model-and-generate-delimited-file)
    - [Step 5: Update Process Status of Processed Records](#step-5-update-process-status-of-processed-records)
8. [Database Table & Entity](#9-database-table--entity)
    - [Table: `IFMIS_PO_HEADER_STG_T`](#table-ifmis_po_header_stg_t)
    - [Table: `IFMIS_PO_LINE_STG_T`](#table-ifmis_po_line_stg_t)
    - [Table: `IFMIS_PO_VENDOR_UPDATE_STG_T`](#table-ifmis_po_vendor_update_stg_t)
    - [Table: `IFMIS_PO_EXTRACT_JOB_DETAILS_T`](#table-ifmis_po_extract_job_details_t)
9. [Data Mapping (MapStruct)](#10-data-mapping-mapstruct)
    - [Purchase Order Header Mapping (`POHeader` to `EDIModel`)](#purchase-order-header-mapping-poheader-to-edimodel)
    - [Purchase Order Line Mapping (`POLine` to `EDIModel`)](#purchase-order-line-mapping-poline-to-edimodel)
    - [Vendor Update Mapping (`POVendorUpdateStg` to `EDIModel`)](#vendor-update-mapping-povendorupdatestg-to-edimodel)
10. [API Endpoints Summary](#11-api-endpoints-summary)
11. [Error Handling & Status Tracking](#12-error-handling--status-tracking)
    - [Error Handling Strategy](#error-handling-strategy)
    - [What Happens on Error](#what-happens-on-error)
    - [Retry Mechanism](#retry-mechanism)
    - [Validation](#validation)
    - [Logging and Monitoring](#logging-and-monitoring)
    - [Status Tracking](#status-tracking)
12. [WebClient & Proxy Configuration Details](#13-webclient--proxy-configuration-details)
13. [Legacy / Unused Classes](#14-legacy--unused-classes)
    - [`POVendorUpdateStg`](#povendorupdatestg)
    - [`Record0005Vo`](#record0005vo)
    - [`Record1000Vo`](#record1000vo)
    - [`Record2000Vo`](#record2000vo)
    - [`settings.xml`](#settingsxml)
    - [`sonardevmain` and `sonardevsit`](#sonardevmain-and-sonardevsit)
    - [Commented-Out Dependencies in `pom.xml`](#commented-out-dependencies-in-pomxml)
    - [Unused Configuration Properties in `application.properties`](#unused-configuration-properties-in-applicationproperties)
14. [End-to-End Flow Diagram](#15-end-to-end-flow-diagram)
15. [Key Business Rules Summary](#16-key-business-rules-summary)
16. [AssetWorks API Call Audit](#17-assetworks-api-call-audit)
    - [Base URL](#base-url)
    - [Authentication](#authentication)
    - [GET Calls — Data Reads from AssetWorks](#get-calls--data-reads-from-assetworks)
    - [POST Calls — Data Writes to AssetWorks](#post-calls--data-writes-to-assetworks)
    - [PUT Calls — Data Updates to AssetWorks](#put-calls--data-updates-to-assetworks)
    - [DELETE Calls — Data Deletions in AssetWorks](#delete-calls--data-deletions-in-assetworks)
    - [Broad/Unfiltered Data Pulls](#broadunfiltered-data-pulls)
---

## 1. Overview
The **IFMIS Purchase Order Change Retrieval Out** service is a **batch-style Spring Boot application** designed to process purchase order (PO) changes captured in the FMIS Integration Layer and generate a delimited file for outbound transfer.

**Key characteristics:**

- It is **not** a web server — it runs as a command-line job (`WebApplicationType.NONE`).
- On startup, it processes purchase order changes based on a provided `runJobId` or default criteria, generates an EDI-compliant delimited file, and then exits.
- The service reads data from an Oracle database, processes it into an EDI model, and writes the output to a file in a specified directory.
- The service uses the following database tables:
  - `IFMIS_PO_HEADER_STG_T` for purchase order headers.
  - `IFMIS_PO_LINE_STG_T` for purchase order lines.
- Processing status is tracked per record in the database using specific status codes:
  - `S` (Success)
  - `Q` (Queued)
  - Other statuses as defined in the database schema.
- The generated delimited file is saved to a directory specified by the `file.directory` property in the `application.properties` file. The file name includes a prefix (`FMIS_860_`), a timestamp (`yyyyMMdd_HHmmss`), and a `.DAT` suffix.

The service is implemented using the Spring Boot framework (version 3.5.10) and leverages the following dependencies:

- `spring-boot-starter-web`: Provides core Spring MVC functionality.
- `spring-boot-starter-batch`: Enables batch processing capabilities.
- `spring-boot-starter-data-jdbc` and `spring-boot-starter-data-jpa`: Provide database access and JPA support.
- `ojdbc8`: Oracle JDBC driver for database connectivity.
- `commons-lang3`: Provides utility functions for Java.
- `commons-cli`: Supports parsing command-line arguments.
- `ifmis-log`: Custom logging library for the IFMIS system.
- `spring-boot-starter-test` and `spring-batch-test`: Provide testing utilities for Spring Boot and Spring Batch applications.
- `junit-jupiter`: JUnit 5 testing framework.

The service is packaged as a JAR file and runs in a Docker container based on the `artifactory.usps.gov/common-docker/usps-neo/java:v17-jre` image. The application listens on port `8081` as configured in the `application.properties` file.

---

## 2. Glossary & Key Terminology
| Term | Full Name | Description |
|------|-----------|-------------|
| **IFMIS** | Integrated Fleet Management Information System | The overarching system responsible for managing financial and procurement operations, including purchase orders. This service is a part of the IFMIS ecosystem. |
| **FMIS** | Financial Management Information System | A subsystem within IFMIS that handles financial data and integration with external systems. This service processes purchase order changes captured in the FMIS Integration Layer. |
| **PO** | Purchase Order | A document issued by a buyer to a seller, indicating the type, quantity, and agreed price for products or services. This service processes changes to purchase orders. |
| **PO Header** | Purchase Order Header | Represents the main details of a purchase order, such as the trading partner code, job ID, and record status. Stored in the `IFMIS_PO_HEADER_STG_T` table. |
| **PO Line** | Purchase Order Line | Represents individual line items within a purchase order, such as specific products or services. Stored in the `IFMIS_PO_LINE_STG_T` table. |
| **EDI** | Electronic Data Interchange | A standardized format for exchanging business information electronically. This service generates EDI files for purchase order changes. |
| **EDIModel** | Electronic Data Interchange Model | A Java model class used to represent the structure of the EDI data for generating delimited files. |
| **Record Status** | — | A field in the database tables (`IFMIS_PO_HEADER_STG_T` and `IFMIS_PO_LINE_STG_T`) that tracks the processing status of records. Common values include `S` (Success), `Q` (Queued), and `E` (Error). |
| **Batch Job** | — | The service runs as a batch job, processing purchase order changes in bulk based on specific criteria and generating a delimited file. |
| **Delimited File** | — | A text file where fields are separated by a specific delimiter (e.g., comma or pipe). This service generates delimited files with purchase order change data for outbound transfer. |
| **OracleDB** | Oracle Database | The relational database used by the service to store and retrieve purchase order data. |
| **HikariCP** | — | A high-performance JDBC connection pool used for managing database connections efficiently. |
| **Spring Batch** | — | A framework provided by Spring Boot for batch processing. This service uses Spring Batch to manage the execution of the purchase order change processing job. |
| **Spring Data JPA** | — | A Spring framework module used for interacting with the database using Java Persistence API (JPA). This service uses Spring Data JPA for database operations. |
| **Lombok** | — | A Java library used to reduce boilerplate code by generating getters, setters, constructors, and other methods at compile time. |
| **Job ID** | — | A unique identifier for a specific batch job execution. It is used to filter purchase order records for processing. |
| **File Directory** | — | The directory specified in the `application.properties` file where the generated delimited files are stored. |
| **File Prefix** | — | A prefix added to the names of the generated delimited files. Configured in the `application.properties` file as `file.prefix`. |
| **File Suffix** | — | A suffix added to the names of the generated delimited files. Configured in the `application.properties` file as `file.suffix`. |
| **File Date Format** | — | The date format used in the names of the generated delimited files. Configured in the `application.properties` file as `file.dateFormat`. |

---

## 3. Architecture & Technology Stack

| Component            | Technology                                                                 |
|-----------------------|---------------------------------------------------------------------------|
| **Framework**         | Spring Boot (non-web, `CommandLineRunner`)                               |
| **Batch Processing**  | Spring Batch                                                             |
| **Database**          | Oracle (via Spring Data JPA + Hibernate)                                 |
| **Connection Pool**   | HikariCP                                                                 |
| **Object Mapping**    | Java POJOs with Lombok annotations                                       |
| **File Handling**     | Java I/O for delimited file generation                                   |
| **Logging**           | Custom logging via `gov.usps.eir9334:ifmis-log` library                  |
| **Build**             | Maven                                                                   |
| **Containerization**  | Docker (Base image: `artifactory.usps.gov/common-docker/usps-neo/java:v17-jre`) |

### Key Classes

| Class                          | Role                                                                 |
|--------------------------------|----------------------------------------------------------------------|
| `IFMISPOChgTransferApplication` | Entry point — implements `CommandLineRunner` to initiate batch processing. |
| `BatchProcessingService`        | Orchestrator — manages the main batch processing flow for purchase order changes. |
| `POTransferService`             | Handles database retrieval of purchase order data and generates delimited files. |
| `POHeaderRepository`            | Spring Data JPA repository for accessing and modifying `POHeader` entities. |
| `POLineRepository`              | Spring Data JPA repository for accessing and modifying `POLine` entities. |
| `POExtractJobDetails`           | Entity representing job details for purchase order extraction.      |
| `EDIModel`                      | Represents the EDI data structure used for delimited file generation. |
| `AppConstants`                  | Utility class for application-wide constants.                       |

### Additional Details

- **Spring Batch**: The service uses Spring Batch to manage the batch processing of purchase order changes. The batch job is triggered via the `IFMISPOChgTransferApplication` class, which passes control to the `BatchProcessingService` for execution.
- **Database Access**: The service interacts with an Oracle database using Spring Data JPA repositories (`POHeaderRepository`, `POLineRepository`) and Hibernate ORM. Queries are defined using both JPA method naming conventions and custom JPQL/SQL.
- **File Generation**: Delimited files are generated using Java I/O based on the `EDIModel` structure. File naming conventions and directory paths are configured in `application.properties`.
- **Logging**: The service uses a custom logging library (`gov.usps.eir9334:ifmis-log`) for structured error logging and operational insights.
- **Containerization**: The service is containerized using Docker, with a base image of `artifactory.usps.gov/common-docker/usps-neo/java:v17-jre`. The application JAR is copied into the container, and the service listens on port `8080` (mapped to `8081` in the application properties).

---

## 4. Configuration & Environment Variables
Configuration is defined in `application.properties` and injected via environment variables:

### Application Server

| Property              | Env Variable | Description                     |
|-----------------------|--------------|---------------------------------|
| `server.port`         | —            | Port on which the application listens (default: `8081`) |

### Database

| Property                                | Env Variable       | Description                                      |
|-----------------------------------------|--------------------|--------------------------------------------------|
| `spring.datasource.url`                 | `DB_CONNECTION_STRING` | Oracle JDBC connection string                     |
| `spring.datasource.username`            | `DB_USERNAME`      | Database username                                |
| `spring.datasource.password`            | `DB_PASSWORD`      | Database password                                |
| `spring.datasource.driver-class-name`   | —                  | JDBC driver class name (default: `oracle.jdbc.OracleDriver`) |
| `spring.jpa.database-platform`          | —                  | JPA database platform (default: `org.hibernate.dialect.OracleDialect`) |
| `spring.jpa.hibernate.use-new-id-generator-mappings` | — | Hibernate ID generator mappings (default: `false`) |
| `spring.jpa.properties.hibernate.default_schema` | `DB_SCHEMA` | Oracle schema name                               |
| `spring.jpa.hibernate.ddl-auto`         | —                  | Hibernate DDL auto configuration (default: `update`) |

### File Generation

| Property         | Env Variable       | Description                                      |
|------------------|--------------------|--------------------------------------------------|
| `file.directory` | `IFMIS_OUTBOUND_DIR` | Directory path for storing generated files       |
| `file.prefix`    | —                  | Prefix for generated file names (default: `FMIS_860_`) |
| `file.dateFormat`| —                  | Date format to append to generated file names (default: `yyyyMMdd_HHmmss`) |
| `file.suffix`    | —                  | Suffix for generated file names (default: `.DAT`) |

---

## 5. Application Startup

```
main()
  └──> SpringApplicationBuilder (WebApplicationType.NONE)
         └──> run(args)
                └──> CommandLineRunner.run()
                       └──> BatchProcessingService.potransfer(runJobId)
                              ├──> POTransferService.retrievePoHeadersByJobIdAndPoRecordStatusInAndEdiFormatId()
                              │      └──> POHeaderRepository.findByPoJobIdAndPoRecordStatusInAndEdiFormatIdOrderByTradingPartnerCodeAscIdAsc()
                              ├──> POTransferService.retrievePoHeadersByRecordStatusInAndEdiFormatId()
                              │      └──> POHeaderRepository.findByPoRecordStatusInAndEdiFormatIdOrderByTradingPartnerCodeAscIdAsc()
                              └──> POTransferService.prepareEDIModelFromPoHeaderList()
                                     └──> EDIModel (data transformation)
                                     └──> File generation
```

**Step-by-step:**

1. The `main()` method in `IFMISPOChgTransferApplication` initializes the Spring Boot application using `SpringApplicationBuilder` with `WebApplicationType.NONE`, indicating that this is a non-web application.
2. The application is started with the provided command-line arguments using the `run(args)` method.
3. After startup, the `CommandLineRunner.run()` method is automatically invoked. This method is implemented in the `IFMISPOChgTransferApplication` class.
4. Inside the `run()` method, command-line arguments are parsed to extract an optional `runJobId`. If no `runJobId` is provided, it defaults to `0`.
5. The `BatchProcessingService.potransfer(runJobId)` method is called with the parsed `runJobId`.
6. Inside the `BatchProcessingService.potransfer()` method:
   - If `runJobId` is not `0`, the method calls `POTransferService.retrievePoHeadersByJobIdAndPoRecordStatusInAndEdiFormatId()` to retrieve `POHeader` entities based on the job ID, record statuses (`S` or `Q`), and EDI format ID.
     - This method internally uses the `POHeaderRepository.findByPoJobIdAndPoRecordStatusInAndEdiFormatIdOrderByTradingPartnerCodeAscIdAsc()` JPA query to fetch the data from the `IFMIS_PO_HEADER_STG_T` table.
   - If `runJobId` is `0`, the method calls `POTransferService.retrievePoHeadersByRecordStatusInAndEdiFormatId()` to retrieve `POHeader` entities based on record statuses (`S` or `Q`) and EDI format ID.
     - This method internally uses the `POHeaderRepository.findByPoRecordStatusInAndEdiFormatIdOrderByTradingPartnerCodeAscIdAsc()` JPA query to fetch the data from the `IFMIS_PO_HEADER_STG_T` table.
   - If no `POHeader` entities are found, a log message is generated stating "No records to process," and the method exits.
   - If `POHeader` entities are found, the method calls `POTransferService.prepareEDIModelFromPoHeaderList()` to process the retrieved data.
7. Inside `POTransferService.prepareEDIModelFromPoHeaderList()`:
   - The method transforms the list of `POHeader` entities into an `EDIModel` object.
   - The `EDIModel` is then used to generate a delimited file in the directory specified by the `file.directory` property in `application.properties`.
8. Once the file generation is complete, the application logs the completion status and exits.

---

## 6. Authentication — Token API

This service does not interact with any external APIs and does not require authentication via a token API. All data processing is performed using data retrieved from the Oracle database configured in the `application.properties` file. 

### Database Authentication

The service connects to an Oracle database using the following properties defined in `application.properties`:

| Property Key                     | Description                          |
|----------------------------------|--------------------------------------|
| `spring.datasource.url`          | The JDBC URL for the Oracle database. |
| `spring.datasource.username`     | The username for the database connection. |
| `spring.datasource.password`     | The password for the database connection. |
| `spring.datasource.driver-class-name` | The driver class name for the Oracle database connection. |

These properties are expected to be provided as environment variables:

- `DB_CONNECTION_STRING`: The JDBC connection string for the Oracle database.
- `DB_USERNAME`: The username for the database connection.
- `DB_PASSWORD`: The password for the database connection.

### Authentication Flow

1. When the application starts, the `IFMISPOChgTransferApplication` class initializes the Spring Boot application context.
2. The database connection is established using the credentials and connection string provided in the `application.properties` file.
3. The service uses Spring Data JPA repositories (`POHeaderRepository`, `POLineRepository`, etc.) to interact with the database for retrieving and updating data.

### Security Considerations

- The database credentials (`DB_USERNAME`, `DB_PASSWORD`) and connection string (`DB_CONNECTION_STRING`) are externalized as environment variables to avoid hardcoding sensitive information in the source code.
- The `application.properties` file uses placeholders (`${...}`) to reference these environment variables, ensuring that sensitive data is not exposed in the codebase.

---

## 7. Purchase Order Change Processing Flow
**Entry point:** `IFMISPOChgTransferApplication.main(String[] args)`

The purchase order change processing flow involves reading purchase order (PO) changes from the database, preparing an EDI model, and generating a delimited file for outbound transfer. The flow is initiated via the main application class and proceeds through several service layers.

### Step 1: Application Startup and Command-Line Argument Parsing

**Class:** `IFMISPOChgTransferApplication`  
**Method:** `main(String[] args)`

1. The application starts as a non-web Spring Boot application.
2. Command-line arguments are passed to the `run(String... args)` method for further processing.

**Method:** `run(String... args)`

1. Parses command-line arguments to extract an optional `runJobId` parameter.
   - If `runJobId` is not provided, it defaults to `0`.
2. Calls `BatchProcessingService.potransfer(Long runJobId)` with the parsed `runJobId`.

---

### Step 2: Batch Processing of Purchase Order Changes

**Class:** `BatchProcessingService`  
**Method:** `potransfer(Long runJobId)`

1. Logs the start of the PO change processing job.
2. Determines the PO selection criteria based on the value of `runJobId`:
   - If `runJobId != 0`: Calls `POTransferService.retrievePoHeadersByJobIdAndPoRecordStatusInAndEdiFormatId(Long poJobId, List<String> recordStatusList, String ediFormatId)` to retrieve `POHeader` entities by job ID and record statuses `S` and `Q`.
   - If `runJobId == 0`: Calls `POTransferService.retrievePoHeadersByRecordStatusInAndEdiFormatId(List<String> recordStatusList, String ediFormatId)` to retrieve `POHeader` entities by record statuses `S` and `Q`.
3. If no records are found (`poHeaderList.isEmpty()`):
   - Logs the message: "No records to process."
   - Exits the method.
4. If records are found:
   - Calls `POTransferService.prepareEDIModelFromPoHeaderList(List<POHeader> poHeaderList)` to process the PO headers and generate a delimited file.

---

### Step 3: Retrieve Purchase Order Headers

**Class:** `POTransferService`  
**Methods:**

1. `retrievePoHeadersByJobIdAndPoRecordStatusInAndEdiFormatId(Long poJobId, List<String> recordStatusList, String ediFormatId)`
   - Retrieves `POHeader` entities from the database based on the provided job ID, record statuses, and EDI format ID.
   - Uses the repository method: `POHeaderRepository.findByPoJobIdAndPoRecordStatusInAndEdiFormatIdOrderByTradingPartnerCodeAscIdAsc(Long poJobId, List<String> recordStatusList, String ediFormatId)`.
   - Parameters:
     - `poJobId`: The job ID for filtering PO headers.
     - `recordStatusList`: List of record statuses (`S`, `Q`).
     - `ediFormatId`: The EDI format ID for filtering.
   - Returns: `List<POHeader>` containing the matching PO headers.

2. `retrievePoHeadersByRecordStatusInAndEdiFormatId(List<String> recordStatusList, String ediFormatId)`
   - Retrieves `POHeader` entities from the database based on the provided record statuses and EDI format ID.
   - Uses the repository method: `POHeaderRepository.findByPoRecordStatusInAndEdiFormatIdOrderByTradingPartnerCodeAscIdAsc(List<String> recordStatusList, String ediFormatId)`.
   - Parameters:
     - `recordStatusList`: List of record statuses (`S`, `Q`).
     - `ediFormatId`: The EDI format ID for filtering.
   - Returns: `List<POHeader>` containing the matching PO headers.

---

### Step 4: Prepare EDI Model and Generate Delimited File

**Class:** `POTransferService`  
**Method:** `prepareEDIModelFromPoHeaderList(List<POHeader> poHeaderList)`

1. Converts the list of `POHeader` entities into an `EDIModel` object.
2. Generates a delimited file using the `EDIModel` data.
   - Iterates over the `poHeaderList` to extract relevant data.
   - Maps the data from `POHeader` entities to the `EDIModel` structure.
3. The file is saved to the directory specified by the `file.directory` property in `application.properties`.

**File Naming Convention:**
- The file name is constructed using the following format:
  ```
  ${file.directory}/${file.prefix}${file.dateFormat}${file.suffix}
  ```
  - `file.prefix`: `FMIS_860_`
  - `file.dateFormat`: `yyyyMMdd_HHmmss`
  - `file.suffix`: `.DAT`

---

### Step 5: Update Process Status of Processed Records

**Class:** `POHeaderRepository`  
**Method:** `updatePoHeaderProcessStatus(Long poHeaderId, String recordStatus)`

1. Updates the process status of a `POHeader` entity after it has been processed.
2. SQL Query:
   ```sql
   UPDATE POHeader ph
   SET ph.poRecordStatus = :recordStatus,
       ph.poLastUpdateDate = SYSDATE
   WHERE ph.id = :poHeaderId
   ```
3. Parameters:
   - `poHeaderId`: The ID of the `POHeader` to update.
   - `recordStatus`: The new record status.

**Class:** `POLineRepository`  
**Method:** `updatePoLineProcessStatus(Long poLineId, String recordStatus)`

1. Updates the process status of a `POLine` entity after it has been processed.
2. SQL Query:
   ```sql
   UPDATE POLine pl
   SET pl.poLineRecordStatus = :recordStatus,
       pl.poLineLastUpdateDate = SYSDATE
   WHERE pl.id = :poLineId
   ```
3. Parameters:
   - `poLineId`: The ID of the `POLine` to update.
   - `recordStatus`: The new record status.

---
## 9. Database Table & Entity

### Table: `IFMIS_PO_HEADER_STG_T`

This table stores the purchase order (PO) header information that is processed by the service. It is the primary source of data for generating the delimited file.

| Column                  | Java Field               | Type       | Description                                                                 |
|-------------------------|--------------------------|------------|-----------------------------------------------------------------------------|
| `ID`                    | `id`                    | Long       | Primary key for the PO header record.                                       |
| `PO_JOB_ID`             | `poJobId`               | Long       | Identifier for the job associated with the PO header.                      |
| `PO_RECORD_STATUS`      | `poRecordStatus`        | String     | Status of the PO record (e.g., `S` for selected, `Q` for queued).           |
| `EDI_FORMAT_ID`         | `ediFormatId`           | String     | Identifier for the EDI format associated with the PO.                      |
| `TRADING_PARTNER_CODE`  | `tradingPartnerCode`    | String     | Code representing the trading partner for the PO.                          |
| `PO_LAST_UPDATE_DATE`   | `poLastUpdateDate`      | Timestamp  | Timestamp of the last update to the PO header record.                      |

---

### Table: `IFMIS_PO_LINE_STG_T`

This table stores the line-level details of purchase orders. It is used to retrieve and update information related to individual PO lines.

| Column                  | Java Field               | Type       | Description                                                                 |
|-------------------------|--------------------------|------------|-----------------------------------------------------------------------------|
| `ID`                    | `id`                    | Long       | Primary key for the PO line record.                                         |
| `TRADING_PARTNER_CODE`  | `tradingPartnerCode`    | String     | Code representing the trading partner for the PO line.                     |
| `PO_NUMBER`             | `poNumber`              | String     | Purchase order number associated with the line.                            |
| `PO_JOB_ID`             | `poJobId`               | Long       | Identifier for the job associated with the PO line.                        |
| `PO_LINE_RECORD_STATUS` | `poLineRecordStatus`    | String     | Status of the PO line record (e.g., `S` for selected, `Q` for queued).     |
| `PO_LINE_NUMBER`        | `poLineNumber`          | Integer    | Line number within the purchase order.                                     |
| `PO_LINE_LAST_UPDATE_DATE` | `poLineLastUpdateDate` | Timestamp  | Timestamp of the last update to the PO line record.                        |

---

### Table: `IFMIS_PO_VENDOR_UPDATE_STG_T`

This table stores vendor update information related to purchase orders. It is referenced during the processing of PO changes.

| Column                  | Java Field               | Type       | Description                                                                 |
|-------------------------|--------------------------|------------|-----------------------------------------------------------------------------|
| `ID`                    | `id`                    | Long       | Primary key for the vendor update record.                                   |
| `VENDOR_CODE`           | `vendorCode`            | String     | Code representing the vendor.                                              |
| `VENDOR_NAME`           | `vendorName`            | String     | Name of the vendor.                                                        |
| `VENDOR_UPDATE_DATE`    | `vendorUpdateDate`      | Timestamp  | Timestamp of the last update to the vendor record.                         |

---

### Table: `IFMIS_PO_EXTRACT_JOB_DETAILS_T`

This table stores details about the jobs that are executed for extracting purchase order changes.

| Column                  | Java Field               | Type       | Description                                                                 |
|-------------------------|--------------------------|------------|-----------------------------------------------------------------------------|
| `ID`                    | `id`                    | Long       | Primary key for the job details record.                                     |
| `JOB_NAME`              | `jobName`               | String     | Name of the job.                                                           |
| `JOB_STATUS`            | `jobStatus`             | String     | Status of the job (e.g., `COMPLETED`, `FAILED`).                           |
| `JOB_START_TIME`        | `jobStartTime`          | Timestamp  | Timestamp when the job started.                                            |
| `JOB_END_TIME`          | `jobEndTime`            | Timestamp  | Timestamp when the job ended.                                              |
| `TOTAL_RECORDS_PROCESSED` | `totalRecordsProcessed` | Integer    | Total number of records processed by the job.                              |
| `ERROR_COUNT`           | `errorCount`            | Integer    | Number of errors encountered during the job execution.                     |

---

## 10. Data Mapping (MapStruct)

### Purchase Order Header Mapping (`POHeader` to `EDIModel`)

```
POHeader Entity Field             EDIModel Field
─────────────────────────          ──────────────────────────────
id                           ───►  poHeaderId
poNumber                     ───►  poNumber
poDate                       ───►  poDate
tradingPartnerCode           ───►  tradingPartnerCode
poRecordStatus               ───►  recordStatus
poLastUpdateDate             ───►  lastUpdateDate
ediFormatId                  ───►  ediFormatId
```

### Purchase Order Line Mapping (`POLine` to `EDIModel`)

```
POLine Entity Field                EDIModel Field
─────────────────────────          ──────────────────────────────
id                           ───►  poLineId
poNumber                     ───►  poNumber
poLineNumber                 ───►  lineNumber
poLineDescription            ───►  description
poLineQuantity               ───►  quantity
poLineUnitPrice              ───►  unitPrice
poLineRecordStatus           ───►  recordStatus
poLineLastUpdateDate         ───►  lastUpdateDate
```

### Vendor Update Mapping (`POVendorUpdateStg` to `EDIModel`)

```
POVendorUpdateStg Entity Field     EDIModel Field
─────────────────────────          ──────────────────────────────
id                           ───►  vendorUpdateId
vendorCode                   ───►  vendorCode
vendorName                   ───►  vendorName
vendorAddress                ───►  vendorAddress
vendorCity                   ───►  vendorCity
vendorState                  ───►  vendorState
vendorZipCode                ───►  vendorZipCode
vendorPhone                  ───►  vendorPhone
vendorEmail                  ───►  vendorEmail
vendorUpdateDate             ───►  updateDate
```

---

## 11. API Endpoints Summary

This service does not expose or consume any HTTP API endpoints. All processing is performed internally within the application, including database interactions and file generation. No external HTTP API calls are made.

---

## 12. Error Handling & Status Tracking

### Error Handling Strategy

- Each purchase order (PO) header and its associated PO lines are processed independently within a try/catch block.
- If processing of a single PO header or its associated lines fails, the error is logged, and the processing continues with the next PO header.
- The batch job is designed to handle errors gracefully without halting the entire process.

### What Happens on Error

1. **PO Header Processing Errors:**
   - If an error occurs while processing a `POHeader`, the `poRecordStatus` field of the corresponding `POHeader` entity is updated to `"E"` (Error).
   - The error is logged using the logging framework integrated into the service.
   - The `poLastUpdateDate` field of the `POHeader` entity is updated to the current system date and time.

2. **PO Line Processing Errors:**
   - If an error occurs while processing a `POLine`, the `poLineRecordStatus` field of the corresponding `POLine` entity is updated to `"E"` (Error).
   - The error is logged with details about the specific `POLine` that failed.
   - The `poLineLastUpdateDate` field of the `POLine` entity is updated to the current system date and time.

3. **File Generation Errors:**
   - If an error occurs during the generation of the delimited file, the error is logged, and the batch job terminates gracefully.
   - No updates are made to the database for the affected records in this case.

4. **Database Update Errors:**
   - If an error occurs while updating the status of a `POHeader` or `POLine` in the database, the error is logged, and the batch job continues processing other records.

### Retry Mechanism

- Records with status `"E"` (Error) are included in the next batch job run for reprocessing. This is achieved by querying `POHeader` and `POLine` entities with `poRecordStatus` or `poLineRecordStatus` values of `"E"`.
- This ensures that failed records are automatically retried in subsequent executions of the batch job.

### Validation

- The service does not explicitly use a validation framework like Jakarta Bean Validation for entity validation. However, the following implicit validations are performed:
  - Only `POHeader` entities with `poRecordStatus` values of `"S"` (Success) or `"Q"` (Queued) are selected for processing.
  - Only `POLine` entities with `poLineRecordStatus` values of `"S"` (Success) are selected for processing.
- If a record does not meet the selection criteria, it is excluded from processing and remains in its current state in the database.

### Logging and Monitoring

- The service uses a logging framework (not explicitly specified in the provided code) to log errors and processing details.
- Logs include information about the specific `POHeader` or `POLine` that encountered an error, along with the error message and stack trace.
- The logging mechanism ensures that all errors are captured for troubleshooting and analysis.

### Status Tracking

- The status of each `POHeader` and `POLine` is tracked using the `poRecordStatus` and `poLineRecordStatus` fields, respectively.
- The possible statuses for `POHeader` and `POLine` entities include:
  - `"S"`: Success
  - `"Q"`: Queued
  - `"E"`: Error
- The `poLastUpdateDate` and `poLineLastUpdateDate` fields are updated whenever the status of a `POHeader` or `POLine` is changed, providing a timestamp for the last update.
- The status fields are used in subsequent queries to determine which records need to be processed or retried.

---

## 13. WebClient & Proxy Configuration Details

This service does not utilize a `WebClient` for outbound HTTP communication, nor does it configure any proxy settings. All processing is performed locally within the application, including database interactions and file generation. There are no external HTTP API calls or proxy configurations defined in the provided source code or configuration files. 

If future requirements necessitate the addition of HTTP communication or proxy configurations, this section should be updated accordingly to document the relevant details.

---

## 14. Legacy / Unused Classes
The codebase contains some classes that are **not actively used** in the main processing flow but remain in the codebase:

### `POVendorUpdateStg`
This entity class, located in `src/main/java/com/ifmis/common/poe/entity/POVendorUpdateStg.java`, represents a staging table for vendor updates related to purchase orders. However, it is **not referenced** in any of the active services, repositories, or processing flows in the current implementation.

- **Fields:**
  - `id` (Long): Primary key for the entity.
  - `vendorCode` (String): Represents the vendor code.
  - `vendorName` (String): Represents the vendor name.
  - `updateTimestamp` (Timestamp): Timestamp of the last update.
  - `status` (String): Status of the vendor update.

- **Purpose:** This class appears to have been designed for handling vendor-related updates in the purchase order process but is not utilized in the current processing logic.

### `Record0005Vo`
This value object class, located in `src/main/java/com/ifmis/potransfer/app/vo/Record0005Vo.java`, is part of the EDI model structure. It is intended to represent a specific record type in the EDI file format. However, it is **not actively used** in the current implementation of the EDI file generation process.

- **Fields:**
  - `recordType` (String): Represents the type of the record.
  - `vendorCode` (String): Vendor code associated with the record.
  - `vendorName` (String): Vendor name associated with the record.

- **Purpose:** This class may have been part of an earlier design for the EDI file structure but is not referenced in the current `EDIModel` or related processing methods.

### `Record1000Vo`
This value object class, located in `src/main/java/com/ifmis/potransfer/app/vo/Record1000Vo.java`, is another component of the EDI model structure. Similar to `Record0005Vo`, it is **not actively used** in the current implementation.

- **Fields:**
  - `recordType` (String): Represents the type of the record.
  - `poNumber` (String): Purchase order number.
  - `poDate` (Date): Date of the purchase order.

- **Purpose:** This class appears to have been intended for use in the EDI file generation process but is not currently utilized.

### `Record2000Vo`
This value object class, located in `src/main/java/com/ifmis/potransfer/app/vo/Record2000Vo.java`, is also part of the EDI model structure. Like the other `Record` classes, it is **not actively used** in the current implementation.

- **Fields:**
  - `recordType` (String): Represents the type of the record.
  - `lineNumber` (Integer): Line number of the purchase order.
  - `itemCode` (String): Code of the item in the purchase order.
  - `quantity` (Integer): Quantity of the item.

- **Purpose:** This class may have been part of an earlier design for the EDI file structure but is not referenced in the current `EDIModel` or related processing methods.

### `settings.xml`
This file, located in the root directory, appears to be a Maven configuration file. However, it is **not actively used** in the current build or runtime processes. The `pom.xml` file contains all the necessary configurations for building and running the application.

- **Purpose:** This file may have been included for specific Maven settings in the past but is not required for the current implementation.

### `sonardevmain` and `sonardevsit`
These files, located in the root directory, are likely related to SonarQube configurations for code quality analysis. However, they are **not actively referenced** in the current build or runtime processes.

- **Purpose:** These files may have been used for setting up SonarQube analysis in earlier stages of development but are not required for the current implementation.

### Commented-Out Dependencies in `pom.xml`
The `pom.xml` file contains a commented-out dependency for `spring-boot-starter-webflux`. This dependency is **not used** in the current implementation.

- **Purpose:** This dependency may have been considered for asynchronous or reactive programming in the past but is not required for the current processing logic.

### Unused Configuration Properties in `application.properties`
The `application.properties` file contains configuration keys for file naming and directory paths related to EDI file generation. However, the following properties are **not actively used** in the current implementation:
- `file.prefix`
- `file.dateFormat`
- `file.suffix`

- **Purpose:** These properties may have been intended for dynamic file naming in the EDI file generation process but are not utilized in the current implementation.

---

## 15. End-to-End Flow Diagram
```mermaid
flowchart TD
    A([APPLICATION STARTUP]) --> B["Spring Boot starts → CommandLineRunner.run()"]
    B --> C["IFMISPOChgTransferApplication.run(String... args)"]
    C --> D["BatchProcessingService.potransfer(Long runJobId)"]

    D --> E{runJobId != 0?}
    E -- YES --> F["POTransferService.retrievePoHeadersByJobIdAndPoRecordStatusInAndEdiFormatId(runJobId, ['S', 'Q'], '860')"]
    E -- NO --> G["POTransferService.retrievePoHeadersByRecordStatusInAndEdiFormatId(['S', 'Q'], '860')"]

    F & G --> H{poHeaderList.isEmpty()?}
    H -- YES --> I["Log 'No records to process.'"]
    H -- NO --> J["POTransferService.prepareEDIModelFromPoHeaderList(poHeaderList)"]

    J --> K["Convert POHeader entities to EDIModel"]
    K --> L["Generate delimited file in directory specified by file.directory"]
    L --> M["Update POHeader and POLine statuses in database"]
    M --> N["Log completion status"]
```

---

## 16. Key Business Rules Summary

1. **If `runJobId` is provided and not equal to `0`, only purchase orders with the specified `runJobId` and record statuses `S` or `Q` are processed.**
   - The method `POTransferService.retrievePoHeadersByJobIdAndPoRecordStatusInAndEdiFormatId(Long poJobId, List<String> recordStatusList, String ediFormatId)` is invoked to retrieve the relevant `POHeader` entities from the database.
   - The `poJobId` parameter is used to filter the records by the specific job ID.
   - The `recordStatusList` parameter is used to filter records with statuses `S` (Selected) or `Q` (Queued).
   - The `ediFormatId` parameter is used to filter records by the EDI format ID.

2. **If `runJobId` is not provided or is equal to `0`, all purchase orders with record statuses `S` or `Q` are processed.**
   - The method `POTransferService.retrievePoHeadersByRecordStatusInAndEdiFormatId(List<String> recordStatusList, String ediFormatId)` is invoked to retrieve the relevant `POHeader` entities from the database.
   - The `recordStatusList` parameter is used to filter records with statuses `S` (Selected) or `Q` (Queued).
   - The `ediFormatId` parameter is used to filter records by the EDI format ID.

3. **If no purchase orders are found for processing, the job logs a message and exits without further processing.**
   - The condition `poHeaderList.isEmpty()` is checked in the method `BatchProcessingService.potransfer(Long runJobId)`.
   - If true, the message "No records to process." is logged, and the method terminates.

4. **If purchase orders are found, they are processed to generate an EDI file.**
   - The method `POTransferService.prepareEDIModelFromPoHeaderList(List<POHeader> poHeaderList)` is invoked to convert the list of `POHeader` entities into an `EDIModel` object.
   - The `EDIModel` object is then used to generate a delimited file in the specified output directory.

5. **Purchase orders are retrieved in ascending order of `tradingPartnerCode` and `id`.**
   - The JPA queries in `POHeaderRepository` include the clause `ORDER BY tradingPartnerCode ASC, id ASC` to ensure consistent ordering of the retrieved records.

6. **The process status of purchase orders is updated after processing.**
   - The method `POHeaderRepository.updatePoHeaderProcessStatus(Long poHeaderId, String recordStatus)` is used to update the `poRecordStatus` field of the `POHeader` entity in the database.
   - The `poHeaderId` parameter specifies the ID of the purchase order to update.
   - The `recordStatus` parameter specifies the new status to set.

7. **Purchase order lines are retrieved and processed based on their associated purchase order.**
   - The method `POLineRepository.findByTradingPartnerCodeAndPoNumberAndPoJobIdAndPoLineRecordStatusOrderByPoLineNumberAsc(String tradingPartnerCode, String poNumber, Long poJobId, String recordStatus)` is used to retrieve `POLine` entities.
   - The `tradingPartnerCode`, `poNumber`, `poJobId`, and `recordStatus` parameters are used to filter the records.
   - The retrieved `POLine` entities are processed as part of the EDI file generation.

8. **The process status of purchase order lines is updated after processing.**
   - The method `POLineRepository.updatePoLineProcessStatus(Long poLineId, String recordStatus)` is used to update the `poLineRecordStatus` field of the `POLine` entity in the database.
   - The `poLineId` parameter specifies the ID of the purchase order line to update.
   - The `recordStatus` parameter specifies the new status to set.

9. **The generated EDI file is saved to a directory specified in the configuration.**
   - The `file.directory` property in `application.properties` determines the output directory for the generated file.
   - The file name is constructed using the `file.prefix`, `file.dateFormat`, and `file.suffix` properties.

10. **The EDI file name includes a timestamp to ensure uniqueness.**
    - The `file.dateFormat` property specifies the format of the timestamp included in the file name.
    - The timestamp is generated at runtime and appended to the file name.

11. **The service uses Oracle database-specific configurations.**
    - The `spring.datasource.url`, `spring.datasource.username`, `spring.datasource.password`, and `spring.datasource.driver-class-name` properties are used to configure the Oracle database connection.
    - The `spring.jpa.database-platform` property is set to `org.hibernate.dialect.OracleDialect` to use the Oracle-specific JPA dialect.

12. **The service updates the `poLastUpdateDate` and `poLineLastUpdateDate` fields to the current system date when updating process statuses.**
    - The SQL queries in `POHeaderRepository.updatePoHeaderProcessStatus` and `POLineRepository.updatePoLineProcessStatus` include the clause `SET poLastUpdateDate = SYSDATE` or `SET poLineLastUpdateDate = SYSDATE`.

13. **The service processes only records with specific EDI format IDs.**
    - The `ediFormatId` parameter is used in all database queries to filter records by their EDI format ID.

14. **The service logs the selection criteria for purchase orders before processing.**
    - The method `BatchProcessingService.potransfer(Long runJobId)` logs the criteria used to retrieve purchase orders, including the `runJobId` and record statuses.

15. **The service does not make any external HTTP API calls or interact with external systems.**
    - All processing is performed locally using data retrieved from the Oracle database.

16. **The service does not use Kafka or any other messaging system for communication.**
    - All operations are performed within the scope of the batch job without external message passing.

---

## 17. AssetWorks API Call Audit
> This section is provided specifically for AssetWorks / M5 integration review.  
> It documents **every API endpoint this service calls**, the exact query parameters and filters applied, the volume of calls made per run, and confirms that no broad/unfiltered data pulls occur.

### Base URL

| Property | Value |
|----------|-------|
| **Config key** | Not applicable (no external API calls are made by this service). |
| **Env variable** | Not applicable. |
| **Example** | Not applicable. |

### Authentication

This service does not make any external API calls and therefore does not require authentication for any external systems.

---

### GET Calls — Data Reads from AssetWorks

This service does not perform any GET calls to external APIs.

---

### POST Calls — Data Writes to AssetWorks

This service does not perform any POST calls to external APIs.

---

### PUT Calls — Data Updates to AssetWorks

This service does not perform any PUT calls to external APIs.

---

### DELETE Calls — Data Deletions in AssetWorks

This service does not perform any DELETE calls to external APIs.

---

### Broad/Unfiltered Data Pulls

This service does not perform any broad or unfiltered data pulls from external APIs. All data processing is performed on records retrieved from the internal Oracle database.