import { createApi } from '@reduxjs/toolkit/dist/query/react'
import { AssetId, CHAIN_REFERENCE, ChainId, toAssetId } from '@shapeshiftoss/caip'
import { DefiType, FoxyApi, WithdrawInfo } from '@shapeshiftoss/investor-foxy'
import { KnownChainIds, MarketData } from '@shapeshiftoss/types'
import { AxiosError } from 'axios'
import axios from 'axios'
import { getConfig } from 'config'
import { getChainAdapterManager } from 'context/PluginProvider/chainAdapterSingleton'
import { BigNumber, BN, bn, bnOrZero } from 'lib/bignumber/bignumber'
import { logger } from 'lib/logger'
import { AssetsById } from 'state/slices/assetsSlice/assetsSlice'
import { PortfolioBalancesById } from 'state/slices/portfolioSlice/portfolioSliceCommon'
import {
  selectAssets,
  selectMarketData,
  selectPortfolioAssetBalances,
  selectPortfolioLoading,
} from 'state/slices/selectors'

import { BASE_RTK_CREATE_API_CONFIG } from '../const'
import { getFoxyApi } from './foxyApiSingleton'

const TOKEMAK_STATS_URL = getConfig().REACT_APP_TOKEMAK_STATS_URL
const TOKEMAK_TFOX_POOL_ADDRESS = '0x808d3e6b23516967ceae4f17a5f9038383ed5311'

type GetFoxyBalancesInput = {
  userAddress: string
  foxyApr: string
}
type GetFoxyBalancesOutput = {
  opportunities: MergedFoxyOpportunity[]
  totalBalance: string
}

type GetFoxyAprOutput = {
  foxyApr: string
}

export type FoxyOpportunity = {
  type: DefiType
  provider: string
  version: string
  contractAddress: string
  rewardToken: string
  stakingToken: string
  chainId: ChainId
  tvl?: string
  expired?: boolean
  apy?: string
  balance: string
  contractAssetId: AssetId
  tokenAssetId: AssetId
  rewardTokenAssetId: AssetId
  pricePerShare: string
  withdrawInfo: WithdrawInfo
}

export type MergedFoxyOpportunity = FoxyOpportunity & {
  cryptoAmount: string
  fiatAmount: string
}

const moduleLogger = logger.child({
  namespace: ['state', 'apis', 'foxy', 'UseFoxyBalances'],
})

type MaybeMarketCapData = Record<AssetId, MarketData | undefined>

type TokemakPool = {
  address: string
  liquidityProviderApr: string
}

type TokemakChainData = {
  chainId: string
  pools: TokemakPool[]
}

const makeFiatAmount = (
  opportunity: FoxyOpportunity,
  assets: AssetsById,
  marketData: MaybeMarketCapData,
) => {
  const asset = assets[opportunity.tokenAssetId]
  const pricePerShare = bnOrZero(opportunity.pricePerShare).div(`1e+${asset?.precision}`)
  const marketPrice = marketData[opportunity.tokenAssetId]?.price
  return bnOrZero(opportunity.balance)
    .div(`1e+${asset?.precision}`)
    .times(pricePerShare)
    .times(bnOrZero(marketPrice))
}

const makeTotalBalance = (
  opportunities: Record<string, FoxyOpportunity>,
  assets: AssetsById,
  marketData: MaybeMarketCapData,
): BN =>
  Object.values(opportunities).reduce((acc: BigNumber, opportunity: FoxyOpportunity) => {
    const amount = makeFiatAmount(opportunity, assets, marketData)
    return acc.plus(bnOrZero(amount))
  }, bn(0))

const makeMergedOpportunities = (
  opportunities: Record<string, FoxyOpportunity>,
  assets: AssetsById,
  marketData: MaybeMarketCapData,
) =>
  Object.values(opportunities).map(opportunity => {
    const asset = assets[opportunity.tokenAssetId]
    const fiatAmount = makeFiatAmount(opportunity, assets, marketData)
    const marketPrice = marketData[opportunity.tokenAssetId]?.price ?? 0
    const tvl = bnOrZero(opportunity.tvl)
      .div(`1e+${asset?.precision}`)
      .times(marketPrice)
      .toString()
    const data = {
      ...opportunity,
      tvl,
      cryptoAmount: bnOrZero(opportunity.balance).div(`1e+${asset?.precision}`).toString(),
      fiatAmount: fiatAmount.toString(),
    }
    return data
  })

async function getFoxyOpportunities(
  balances: PortfolioBalancesById,
  api: FoxyApi,
  userAddress: string,
  foxyApr: string,
) {
  const acc: Record<string, FoxyOpportunity> = {}
  try {
    const opportunities = await api.getFoxyOpportunities()
    const getFoxyOpportunitiesPromises = opportunities.map(async opportunity => {
      // TODO: assetIds in vaults
      const withdrawInfo = await api.getWithdrawInfo({
        contractAddress: opportunity.contractAddress,
        userAddress,
      })
      const rewardTokenAssetId = toAssetId({
        chainId: opportunity.chain,
        assetNamespace: 'erc20',
        assetReference: opportunity.rewardToken,
      })
      const contractAssetId = toAssetId({
        chainId: opportunity.chain,
        assetNamespace: 'erc20',
        assetReference: opportunity.contractAddress,
      })
      const tokenAssetId = toAssetId({
        chainId: opportunity.chain,
        assetNamespace: 'erc20',
        assetReference: opportunity.stakingToken,
      })
      const balance = balances[rewardTokenAssetId]

      const pricePerShare = api.pricePerShare()
      acc[opportunity.contractAddress] = {
        ...opportunity,
        tvl: opportunity.tvl.toString(),
        apy: foxyApr,
        chainId: opportunity.chain,
        balance: bnOrZero(balance).toString(),
        contractAssetId,
        tokenAssetId,
        rewardTokenAssetId,
        pricePerShare: bnOrZero(pricePerShare).toString(),
        withdrawInfo,
      }
    })

    await Promise.all(getFoxyOpportunitiesPromises)
    return acc
  } catch (e) {
    moduleLogger.error(e, { fn: 'getFoxyOpportunities' }, 'Error getting opportunities')
    return acc
  }
}

export const foxyApi = createApi({
  ...BASE_RTK_CREATE_API_CONFIG,
  reducerPath: 'foxyApi',
  endpoints: build => ({
    getFoxyBalances: build.query<GetFoxyBalancesOutput, GetFoxyBalancesInput>({
      queryFn: async ({ userAddress, foxyApr }, injected) => {
        const chainAdapterManager = getChainAdapterManager()
        if (!chainAdapterManager.has(KnownChainIds.EthereumMainnet))
          return {
            error: {
              error: `EthereumChainAdapter not found in chainAdapterManager`,
              status: 'CUSTOM_ERROR',
            },
          }

        const { getState } = injected
        const state: any = getState() // ReduxState causes circular dependency

        const balancesLoading = selectPortfolioLoading(state)

        if (balancesLoading)
          return {
            error: {
              error: 'Portfolio balances not loaded',
              status: 'CUSTOM_ERROR',
            },
          }

        const foxy = getFoxyApi()

        const marketData = selectMarketData(state)
        const assets = selectAssets(state)
        const balances = selectPortfolioAssetBalances(state)

        try {
          const foxyOpportunities = await getFoxyOpportunities(
            balances,
            foxy,
            userAddress,
            foxyApr ?? '',
          )

          const totalBalance = makeTotalBalance(foxyOpportunities, assets, marketData)
          const mergedOpportunities = makeMergedOpportunities(foxyOpportunities, assets, marketData)

          return {
            data: {
              opportunities: mergedOpportunities,
              totalBalance: totalBalance.toString(),
            },
          }
        } catch (error) {
          console.error('error', error)
          return {
            error: {
              error: `getFoxyBalances Error`,
              status: 'CUSTOM_ERROR',
            },
          }
        }
      },
    }),
    getFoxyApr: build.query<GetFoxyAprOutput, void>({
      queryFn: async () => {
        try {
          const response = await axios.get<{ chains: TokemakChainData[] }>(TOKEMAK_STATS_URL)
          const tokemakData = response?.data
          // Tokemak only supports mainnet for now, so we could just access chains[0], but this keeps things more declarative
          const tokemakChainData = tokemakData.chains.find(
            ({ chainId }) => chainId === CHAIN_REFERENCE.EthereumMainnet,
          )

          if (!tokemakChainData?.pools) {
            return {
              error: {
                error: 'Cannot get Tokemak pools data',
                status: 'CUSTOM_ERROR',
              },
            }
          }

          const { pools } = tokemakChainData
          const tFoxPool = pools.find(({ address }) => address === TOKEMAK_TFOX_POOL_ADDRESS)

          if (!tFoxPool) {
            return {
              error: {
                error: 'Cannot get Tokemak TFOX pool data',
                status: 'CUSTOM_ERROR',
              },
            }
          }

          return { data: { foxyApr: tFoxPool.liquidityProviderApr } }
        } catch (e) {
          if ((e as AxiosError).isAxiosError) {
            return {
              error: {
                error:
                  (e as AxiosError).response?.statusText ?? 'Cannot get Tokemak TFOX pool data',
                status: (e as AxiosError).response?.status ?? 400,
              },
            }
          }

          return {
            error: {
              error: 'Cannot get Tokemak TFOX pool data',
              status: 'PARSING_ERROR',
            },
          }
        }
      },
    }),
  }),
})

export const { useGetFoxyBalancesQuery, useGetFoxyAprQuery } = foxyApi
