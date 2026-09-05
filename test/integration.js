const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Start the adapter against a live js-controller with default (empty)
// credentials. The adapter must start on its own, report
// info.connection=false (missing credentials) and shut down cleanly
// without touching the real Zeekr API.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Zeekr startup without credentials', getHarness => {
            // eslint-disable-next-line no-undef
            it('reports info.connection=false', async function () {
                const harness = getHarness();
                let state = null;
                for (let i = 0; i < 60 && !state; i++) {
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    state = await harness.states.getStateAsync('zeekr.0.info.connection');
                }
                if (!state) {
                    throw new Error('info.connection was not created by the adapter');
                }
                if (state.val !== false) {
                    throw new Error(`expected info.connection=false, got ${state.val}`);
                }
            }).timeout(90000);
        });
    },
});
