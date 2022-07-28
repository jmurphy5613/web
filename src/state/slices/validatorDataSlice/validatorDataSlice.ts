import { createSlice } from '@reduxjs/toolkit'
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import { ChainId } from '@shapeshiftoss/caip'
import { cosmos } from '@shapeshiftoss/chain-adapters'
import {
  isCosmosChainId,
  isOsmosisChainId,
} from 'plugins/cosmos/components/modals/Staking/StakingCommon'
// @ts-ignore this will fail at 'file differs in casing' error
import { getChainAdapterManager } from 'context/PluginProvider/chainAdapterSingleton'
import { logger } from 'lib/logger'
import {
  SHAPESHIFT_COSMOS_VALIDATOR_ADDRESS,
  SHAPESHIFT_OSMOSIS_VALIDATOR_ADDRESS,
} from 'state/slices/validatorDataSlice/constants'

import { PortfolioAccounts } from '../portfolioSlice/portfolioSliceCommon'

const moduleLogger = logger.child({ namespace: ['validatorDataSlice'] })

export type PubKey = string

type SingleValidatorDataArgs = { accountSpecifier: string; chainId: ChainId }

export type Validators = {
  validators: cosmos.Validator[]
}

export type ValidatorData = {
  byValidator: ValidatorDataByPubKey
  validatorIds: PubKey[]
}

export type ValidatorDataByPubKey = {
  [k: PubKey]: cosmos.Validator
}

const initialState: ValidatorData = {
  byValidator: {},
  validatorIds: [],
}

const updateOrInsertValidatorData = (
  validatorDataState: ValidatorData,
  validators: cosmos.Validator[],
) => {
  validators.forEach(validator => {
    validatorDataState.validatorIds.push(validator.address)
    validatorDataState.byValidator[validator.address] = validator
  })
}

export const validatorData = createSlice({
  name: 'validatorData',
  initialState,
  reducers: {
    clear: () => initialState,
    upsertValidatorData: (
      validatorDataState,
      { payload }: { payload: { validators: cosmos.Validator[] } },
    ) => {
      updateOrInsertValidatorData(validatorDataState, payload.validators)
    },
  },
})

export const validatorDataApi = createApi({
  reducerPath: 'validatorDataApi',
  // not actually used, only used to satisfy createApi, we use a custom queryFn
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  // 5 minutes caching against overfetching. The only thing that can change on new Tx is effectively TVL and APR
  // The first won't noticeably change given the Million fiat precision we use, and the former effectively won't noticeably change either in such timeframe
  keepUnusedDataFor: 300,
  // refetch if network connection is dropped, useful for mobile
  refetchOnReconnect: true,
  endpoints: build => ({
    getValidatorData: build.query<cosmos.Validator, SingleValidatorDataArgs>({
      queryFn: async ({ accountSpecifier, chainId }, { dispatch, getState }) => {
        // limitation of redux tookit https://redux-toolkit.js.org/rtk-query/api/createApi#queryfn
        const { byId } = (getState() as any).portfolio.accounts as PortfolioAccounts

        const portfolioAccount = byId[accountSpecifier]

        if (!portfolioAccount) {
          return { error: { data: `No portfolio data found for ${accountSpecifier}`, status: 404 } }
        }

        let validatorAddress = ''

        if (isCosmosChainId(chainId)) {
          validatorAddress = SHAPESHIFT_COSMOS_VALIDATOR_ADDRESS
        }
        if (isOsmosisChainId(chainId)) {
          validatorAddress = SHAPESHIFT_OSMOSIS_VALIDATOR_ADDRESS
        }

        const validatorIds = portfolioAccount.validatorIds?.length
          ? portfolioAccount.validatorIds
          : [validatorAddress]

        const chainAdapters = getChainAdapterManager()
        const adapter = chainAdapters.get(chainId) as cosmos.ChainAdapter | undefined
        if (!adapter) {
          return {
            error: { data: `No adapter available for chainId ${chainId}`, status: 404 },
          }
        }

        const validators = await Promise.allSettled(
          validatorIds.map(async validatorId => {
            try {
              const data = await adapter.getValidator(validatorId)

              dispatch(
                validatorData.actions.upsertValidatorData({
                  validators: [data],
                }),
              )
            } catch (err) {
              if (err instanceof Error) {
                throw new Error(`failed to get data for validator: ${validatorId}: ${err.message}`)
              }
            }
          }),
        )

        validators.forEach(promise => {
          if (promise.status === 'rejected') {
            moduleLogger.child({ fn: 'getValidatorData' }).warn(promise.reason)
          }
        })

        return { data: {} as cosmos.Validator }
      },
    }),
  }),
})
