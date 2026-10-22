// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// BrainerHub: client performance telemetry is disabled. Upstream implementation:
//
//     const store = useStore<GlobalState>();
//     useEffect(() => {
//         const reporter = new PerformanceReporter(Client4, store, DesktopAppAPI);
//         reporter.observe();
//         return () => {
//             reporter.disconnect();
//         };
//     }, [store]);
export default function PerformanceReporterController() {
    return null;
}
