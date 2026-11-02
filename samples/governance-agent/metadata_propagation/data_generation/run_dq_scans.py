import os

from dotenv import load_dotenv

# Load configurations from .env
load_dotenv(override=True)

from metadata_propagation.dataplex_integration.manage_scans import (
    create_dq_scan,
    create_profiling_scan,
    run_scan,
)


def main():
    PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")

    print(
        f"Triggering Dataplex Scans for Raw tables in project: {PROJECT_ID}..."
    )

    try:
        # 1. Profiling + DQ for raw_customers
        print("Configuring scans for raw_customers...")
        create_profiling_scan("raw_customers")
        run_scan("profile-raw-customers")

        create_dq_scan("raw_customers")
        run_scan("dq-scan-raw-customers")

        # 2. Profiling for raw_products
        print("Configuring scan for raw_products...")
        create_profiling_scan("raw_products")
        run_scan("profile-raw-products")

        print("\nAll scans triggered successfully.")
        print(
            "You can monitor progress in the Google Cloud Console (Dataplex > Data scans)."
        )

    except Exception as e:
        print(f"Error: Failed to trigger Dataplex scans: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    main()
