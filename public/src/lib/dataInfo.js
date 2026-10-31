import { eventPageModel } from './eventPageModel.js'
import { fieldModes } from './personFormModel.js'
import { runnerDataInfo } from '../legal/runnerDataInfo.js'

/**
 * The runner data information for one event's public snapshot (/api/event): the same text the
 * registration form (RA2), the consent page (/zgoda) and /events/<slug>/informacja-o-danych show.
 */
export function dataInfoOf(raw, model = eventPageModel(raw)) {
  return runnerDataInfo({
    eventName: model.title, organizerName: model.organizerName, contactEmail: model.contactEmail,
    paid: raw.pricingMode !== 'free', teams: (raw.competitions ?? []).some((c) => c.kind === 'team'),
    nationality: fieldModes(raw.formFields).nationality !== 'off',
  })
}
