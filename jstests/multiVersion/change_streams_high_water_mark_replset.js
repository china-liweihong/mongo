/**
 * Tests that high water mark and postBatchResumeTokens are handled correctly during upgrade from
 * and downgrade to a pre-backport version of 4.0 on a single replica set.
 */
(function() {
    "use strict";

    load("jstests/libs/collection_drop_recreate.js");                // For assertCreateCollection.
    load("jstests/multiVersion/libs/change_stream_hwm_helpers.js");  // For ChangeStreamHWMHelpers.
    load("jstests/multiVersion/libs/index_format_downgrade.js");     // For downgradeUniqueIndexes.
    load("jstests/multiVersion/libs/multi_rs.js");                   // For upgradeSet.
    load("jstests/replsets/rslib.js");  // For startSetIfSupportsReadMajority.

    const preBackport40Version = ChangeStreamHWMHelpers.preBackport40Version;
    const postBackport40Version = ChangeStreamHWMHelpers.postBackport40Version;
    const latest42Version = ChangeStreamHWMHelpers.latest42Version;

    const rst = new ReplSetTest({
        nodes: 3,
        nodeOptions: {binVersion: preBackport40Version},
    });
    if (!startSetIfSupportsReadMajority(rst)) {
        jsTestLog("Skipping test since storage engine doesn't support majority read concern.");
        rst.stopSet();
        return;
    }
    rst.initiate();

    // Obtain references to the test database and create the test collection.
    let testDB = rst.getPrimary().getDB(jsTestName());
    let testColl = testDB.test;

    // Up- or downgrades the replset and then refreshes our references to the test collection.
    function refreshReplSet(version) {
        // Upgrade the set and wait for it to become available again.
        rst.upgradeSet({binVersion: version});
        rst.awaitReplication();

        // Having upgraded the cluster, reacquire references to the db and collection.
        testDB = rst.getPrimary().getDB(jsTestName());
        testColl = testDB.test;
    }

    // We perform these tests once for pre-backport 4.0, and once for post-backport 4.0.
    for (let oldVersion of[preBackport40Version, postBackport40Version]) {
        // Stores a high water mark generated by the most recent test and used in subsequent tests.
        let hwmToken = null;

        // Determine whether we are running a pre- or post-backport version of 4.0.
        const isPostBackport = (oldVersion === postBackport40Version);

        // We start with the replset running on 'oldVersion'. Streams should only produce PBRTs if
        // we are on a post-backport version of 4.0.
        jsTestLog(`Testing binary ${oldVersion}`);
        refreshReplSet(oldVersion);
        hwmToken = ChangeStreamHWMHelpers.testPostBatchAndHighWaterMarkTokens(
            {coll: testColl, expectPBRT: isPostBackport});
        assert.eq(hwmToken != undefined, isPostBackport);

        // Upgrade the replset to 4.2 but leave it in FCV 4.0
        jsTestLog("Upgrading to binary 4.2 with FCV 4.0");
        refreshReplSet(latest42Version);

        // All streams should now return PBRTs, including high water marks.
        jsTestLog("Testing binary 4.2 with FCV 4.0");
        hwmToken = ChangeStreamHWMHelpers.testPostBatchAndHighWaterMarkTokens(
            {coll: testColl, expectPBRT: true, hwmToResume: hwmToken, expectResume: true});
        assert.neq(hwmToken, undefined);

        // Set the replset's FCV to 4.2.
        assert.commandWorked(testDB.adminCommand({setFeatureCompatibilityVersion: "4.2"}));

        // All streams should return PBRTs. We can resume with the HWM token from the previous test.
        jsTestLog("Testing binary 4.2 with FCV 4.2");
        hwmToken = ChangeStreamHWMHelpers.testPostBatchAndHighWaterMarkTokens(
            {coll: testColl, expectPBRT: true, hwmToResume: hwmToken, expectResume: true});
        assert.neq(hwmToken, undefined);

        // Downgrade the cluster to FCV 4.0.
        jsTestLog("Downgrading to FCV 4.0");
        assert.commandWorked(testDB.adminCommand({setFeatureCompatibilityVersion: "4.0"}));

        // All streams should return PBRTs and we can still resume from the last HWM token.
        jsTestLog("Testing binary 4.2 with downgraded FCV 4.0");
        hwmToken = ChangeStreamHWMHelpers.testPostBatchAndHighWaterMarkTokens(
            {coll: testColl, expectPBRT: true, hwmToResume: hwmToken, expectResume: true});
        assert.neq(hwmToken, undefined);

        // Downgrade the cluster to 'oldVersion' after rebuilding all unique indexes so that their
        // format is compatible with binary 4.0.
        jsTestLog(`Downgrading to binary ${oldVersion}`);
        downgradeUniqueIndexes(testDB);
        refreshReplSet(oldVersion);

        // We should receive PBRTs and be able to resume from the earlier HWM tokens only if we have
        // downgraded to a post-backport version of 4.0.
        jsTestLog(`Testing downgraded binary ${oldVersion}`);
        hwmToken = ChangeStreamHWMHelpers.testPostBatchAndHighWaterMarkTokens({
            coll: testColl,
            expectPBRT: isPostBackport,
            hwmToResume: hwmToken,
            expectResume: isPostBackport
        });
        assert.eq(hwmToken != undefined, isPostBackport);
    }

    rst.stopSet();
})();