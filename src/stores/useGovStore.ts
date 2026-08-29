import { defineStore } from 'pinia';
import { useBlockchain } from './useBlockchain';
import type { PageRequest, PaginatedProposals } from '@/types';
import { LoadingStatus } from './useDashboard';
import { useWalletStore } from './useWalletStore';
import { reactive } from 'vue';

export const useGovStore = defineStore('govStore', {
  state: () => {
    return {
      params: {
        deposit: {},
        voting: {},
        tally: {},
      },
      proposals: {} as Record<string, PaginatedProposals>,
      loading: {} as Record<string, LoadingStatus>,
    };
  },
  getters: {
    blockchain() {
      return useBlockchain();
    },
    walletstore() {
      return useWalletStore();
    },
  },
  actions: {
    initial() {
      this.$reset();
      this.fetchProposals('2');
    },
    async fetchProposals(status: string, pagination?: PageRequest) {
      //if (!this.loading[status]) {
      this.loading[status] = LoadingStatus.Loading;
      let proposals: any;
      try {
        proposals = reactive(await this.blockchain.rpc?.getGovProposals(status, pagination));
      } catch (e) {
        // A dead/rate-limited LCD (HTTP 500 on the v1beta1 path for SDK>=0.50
        // chains, aborts, etc.) must not become an unhandled rejection that
        // leaves the tab spinning. Fall back to an empty bucket.
        console.warn('[gov] fetchProposals failed', status, e);
        proposals = reactive({ proposals: [], pagination: { total: '0' } });
      }

      //filter spam proposals
      if (proposals?.proposals) {
        proposals.proposals = proposals.proposals.filter((item: any) => {
          const title = item.title || '';
          return title.toLowerCase().indexOf('airdrop') === -1;
        });
      }

      if (status === '2') {
        proposals?.proposals?.forEach((item: any) => {
          this.fetchTally(item.proposal_id).then((res) => {
            item.final_tally_result = res?.tally;
          }).catch(() => {});
          if (this.walletstore.currentAddress) {
            try {
              this.fetchProposalVotesVoter(item.proposal_id, this.walletstore.currentAddress)
                .then((res) => {
                  item.voterStatus = res?.vote?.option || undefined;
                })
                .catch(() => {
                  item.voterStatus = undefined;
                });
            } catch (error) {
              item.voterStatus = undefined;
            }
          } else {
            item.voterStatus = undefined;
          }
        });
      }

      this.loading[status] = LoadingStatus.Loaded;
      this.proposals[status] = proposals;
      //}
      return this.proposals[status];
    },
    async fetchParams() {
      // this.blockchain.rpc.getGovParamsDeposit().then(x => {
      //     this.params.deposit = x.deposit
      // })
    },
    async fetchTally(proposalId: string) {
      return await this.blockchain.rpc.getGovProposalTally(proposalId);
    },
    async fetchProposal(proposalId: string) {
      return this.blockchain.rpc.getGovProposal(proposalId);
    },
    async fetchProposalDeposits(proposalId: string) {
      return this.blockchain.rpc.getGovProposalDeposits(proposalId);
    },
    async fetchProposalVotes(proposalId: string, page?: PageRequest) {
      return this.blockchain.rpc.getGovProposalVotes(proposalId, page);
    },
    async fetchProposalVotesVoter(proposalId: string, voter: string) {
      return this.blockchain.rpc.getGovProposalVotesVoter(proposalId, voter);
    },
  },
});
