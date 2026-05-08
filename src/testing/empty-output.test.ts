import { printEmpty } from '../empty.js'
import { describeEmptyMachineOutput } from './empty-output.js'

const HUMAN_MESSAGE = 'No widgets found.'

describeEmptyMachineOutput('describeEmptyMachineOutput (smoke against printEmpty)', {
    setup: () => {},
    run: async (extraArgs) => {
        const options = {
            json: extraArgs.includes('--json'),
            ndjson: extraArgs.includes('--ndjson'),
        }
        printEmpty({ options, message: HUMAN_MESSAGE })
    },
    humanMessage: HUMAN_MESSAGE,
})
