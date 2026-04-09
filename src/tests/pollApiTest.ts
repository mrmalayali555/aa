import { examMonitor } from "../api/exam-api-finder";
import { runAllAccountsWithPrewarmedBrowsers } from "../cluster/runCluster";
import { browserPool } from "../browsers/prewarmedBrowserPool";

(async () => {
  // Prewarm 2 browsers for testing
  console.log("🔥 Prewarming 2 browsers for testing...");
  await browserPool.warmup2Browsers();
  console.log("✅ Browsers prewarmed");

  // Simulate OID found for testing booking
  const fakeExam = {
    oid: "TEST_OID_12345",
    locationName: "Test Location",
    eventName: "Test Exam",
    startDate: "2025-09-11T07:30:00.000Z"
  };

  console.log(`🎯 Simulating OID found: ${fakeExam.oid}`);

  try {
    // Run your booking automation
    await runAllAccountsWithPrewarmedBrowsers(fakeExam.oid);
    // Note: Success notification is handled in runAllAccountsWithPrewarmedBrowsers
  } catch (automationError) {
    console.error(`❌ Automation failed:`, automationError);
  }

  // Optional: Also test polling (commented out for now)
  /*
  await examMonitor.startPolling({
    targetTime: new Date("2025-09-11T07:30:00.000+00:00"),
    onOidFound: async (oid, exam) => {
      console.log(`🎯 Processing exam with OID:`, oid);

      try {
        if (exam.oid) {
          // Run your booking automation
          await runAllAccountsWithPrewarmedBrowsers(exam.oid);
          // Note: Success notification is handled in runAllAccountsWithPrewarmedBrowsers
        } else {
          const errorMsg = "No OID found on exam";
          console.log(`❌  ${errorMsg}`);
        }
      } catch (automationError) {
        console.error(`❌ Automation failed:`, automationError);
      }
    },
  });
  */
})();
