// Types for abi.js, generated from the same list (see there). JSON is valid type syntax, so
// wagmi infers function names and arguments from this literal.
export declare const GONDI_LOAN_ABI: [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "loanId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256[]",
        "name": "offerId",
        "type": "uint256[]"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "borrower",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftCollateralTokenId",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "nftCollateralAddress",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "principalAddress",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "principalAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "startTime",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "duration",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "uint256",
                "name": "loanId",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "floor",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "principalAmount",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "lender",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "accruedInterest",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "startTime",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "aprBps",
                "type": "uint256"
              }
            ],
            "internalType": "struct IMultiSourceLoan.Tranche[]",
            "name": "tranche",
            "type": "tuple[]"
          },
          {
            "internalType": "uint256",
            "name": "protocolFee",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "lenderRefinanceDisabled",
            "type": "bool"
          }
        ],
        "indexed": false,
        "internalType": "struct IMultiSourceLoan.Loan",
        "name": "loan",
        "type": "tuple"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      }
    ],
    "name": "LoanEmitted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "loanId",
        "type": "uint256"
      }
    ],
    "name": "LoanForeclosed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "loanId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "foreclosed",
        "type": "bool"
      }
    ],
    "name": "LoanLiquidated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "renegotiationId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "oldLoanId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newLoanId",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "borrower",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftCollateralTokenId",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "nftCollateralAddress",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "principalAddress",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "principalAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "startTime",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "duration",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "uint256",
                "name": "loanId",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "floor",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "principalAmount",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "lender",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "accruedInterest",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "startTime",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "aprBps",
                "type": "uint256"
              }
            ],
            "internalType": "struct IMultiSourceLoan.Tranche[]",
            "name": "tranche",
            "type": "tuple[]"
          },
          {
            "internalType": "uint256",
            "name": "protocolFee",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "lenderRefinanceDisabled",
            "type": "bool"
          }
        ],
        "indexed": false,
        "internalType": "struct IMultiSourceLoan.Loan",
        "name": "loan",
        "type": "tuple"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      }
    ],
    "name": "LoanRefinanced",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "loanId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newLoanId",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "borrower",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftCollateralTokenId",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "nftCollateralAddress",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "principalAddress",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "principalAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "startTime",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "duration",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "uint256",
                "name": "loanId",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "floor",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "principalAmount",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "lender",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "accruedInterest",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "startTime",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "aprBps",
                "type": "uint256"
              }
            ],
            "internalType": "struct IMultiSourceLoan.Tranche[]",
            "name": "tranche",
            "type": "tuple[]"
          },
          {
            "internalType": "uint256",
            "name": "protocolFee",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "lenderRefinanceDisabled",
            "type": "bool"
          }
        ],
        "indexed": false,
        "internalType": "struct IMultiSourceLoan.Loan",
        "name": "loan",
        "type": "tuple"
      },
      {
        "indexed": false,
        "internalType": "uint256[]",
        "name": "offerIds",
        "type": "uint256[]"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "totalFee",
        "type": "uint256"
      }
    ],
    "name": "LoanRefinancedFromNewOffers",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "loanId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "totalRepayment",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      }
    ],
    "name": "LoanRepaid",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "loanId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "liquidator",
        "type": "address"
      }
    ],
    "name": "LoanSentToLiquidator",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "lender",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "offerId",
        "type": "uint256"
      }
    ],
    "name": "OfferCancelled",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "DOMAIN_SEPARATOR",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_offerId",
        "type": "uint256"
      }
    ],
    "name": "cancelOffer",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "components": [
              {
                "components": [
                  {
                    "components": [
                      {
                        "internalType": "uint256",
                        "name": "offerId",
                        "type": "uint256"
                      },
                      {
                        "internalType": "address",
                        "name": "lender",
                        "type": "address"
                      },
                      {
                        "internalType": "uint256",
                        "name": "fee",
                        "type": "uint256"
                      },
                      {
                        "internalType": "uint256",
                        "name": "capacity",
                        "type": "uint256"
                      },
                      {
                        "internalType": "address",
                        "name": "nftCollateralAddress",
                        "type": "address"
                      },
                      {
                        "internalType": "uint256",
                        "name": "nftCollateralTokenId",
                        "type": "uint256"
                      },
                      {
                        "internalType": "address",
                        "name": "principalAddress",
                        "type": "address"
                      },
                      {
                        "internalType": "uint256",
                        "name": "principalAmount",
                        "type": "uint256"
                      },
                      {
                        "internalType": "uint256",
                        "name": "aprBps",
                        "type": "uint256"
                      },
                      {
                        "internalType": "uint256",
                        "name": "expirationTime",
                        "type": "uint256"
                      },
                      {
                        "internalType": "uint256",
                        "name": "duration",
                        "type": "uint256"
                      },
                      {
                        "internalType": "uint256",
                        "name": "maxSeniorRepayment",
                        "type": "uint256"
                      },
                      {
                        "components": [
                          {
                            "internalType": "address",
                            "name": "validator",
                            "type": "address"
                          },
                          {
                            "internalType": "bytes",
                            "name": "arguments",
                            "type": "bytes"
                          }
                        ],
                        "internalType": "struct IBaseLoan.OfferValidator[]",
                        "name": "validators",
                        "type": "tuple[]"
                      },
                      {
                        "internalType": "bool",
                        "name": "lenderRefinanceDisabled",
                        "type": "bool"
                      },
                      {
                        "internalType": "address",
                        "name": "borrower",
                        "type": "address"
                      }
                    ],
                    "internalType": "struct IMultiSourceLoan.LoanOffer",
                    "name": "offer",
                    "type": "tuple"
                  },
                  {
                    "internalType": "uint256",
                    "name": "amount",
                    "type": "uint256"
                  },
                  {
                    "internalType": "bytes",
                    "name": "lenderOfferSignature",
                    "type": "bytes"
                  }
                ],
                "internalType": "struct IMultiSourceLoan.OfferExecution[]",
                "name": "offerExecution",
                "type": "tuple[]"
              },
              {
                "internalType": "uint256",
                "name": "loanId",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "nftCollateralAddress",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "tokenId",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "duration",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "expirationTime",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "principalReceiver",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "callbackData",
                "type": "bytes"
              }
            ],
            "internalType": "struct IMultiSourceLoan.ExecutionData",
            "name": "executionData",
            "type": "tuple"
          },
          {
            "internalType": "address",
            "name": "borrower",
            "type": "address"
          },
          {
            "internalType": "bytes",
            "name": "borrowerOfferSignature",
            "type": "bytes"
          }
        ],
        "internalType": "struct IMultiSourceLoan.LoanExecutionData",
        "name": "_loanExecutionData",
        "type": "tuple"
      }
    ],
    "name": "emitLoan",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "borrower",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftCollateralTokenId",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "nftCollateralAddress",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "principalAddress",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "principalAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "startTime",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "duration",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "uint256",
                "name": "loanId",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "floor",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "principalAmount",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "lender",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "accruedInterest",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "startTime",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "aprBps",
                "type": "uint256"
              }
            ],
            "internalType": "struct IMultiSourceLoan.Tranche[]",
            "name": "tranche",
            "type": "tuple[]"
          },
          {
            "internalType": "uint256",
            "name": "protocolFee",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "lenderRefinanceDisabled",
            "type": "bool"
          }
        ],
        "internalType": "struct IMultiSourceLoan.Loan",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_loanId",
        "type": "uint256"
      }
    ],
    "name": "getLoanHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getProtocolFee",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "recipient",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "fraction",
            "type": "uint256"
          }
        ],
        "internalType": "struct WithProtocolFee.ProtocolFee",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getTotalLoansIssued",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_lender",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "_offerId",
        "type": "uint256"
      }
    ],
    "name": "getUsedCapacity",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "offerId",
        "type": "uint256"
      }
    ],
    "name": "isOfferCancelled",
    "outputs": [
      {
        "internalType": "bool",
        "name": "notActive",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_loanId",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "borrower",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftCollateralTokenId",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "nftCollateralAddress",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "principalAddress",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "principalAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "startTime",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "duration",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "uint256",
                "name": "loanId",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "floor",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "principalAmount",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "lender",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "accruedInterest",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "startTime",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "aprBps",
                "type": "uint256"
              }
            ],
            "internalType": "struct IMultiSourceLoan.Tranche[]",
            "name": "tranche",
            "type": "tuple[]"
          },
          {
            "internalType": "uint256",
            "name": "protocolFee",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "lenderRefinanceDisabled",
            "type": "bool"
          }
        ],
        "internalType": "struct IMultiSourceLoan.Loan",
        "name": "_loan",
        "type": "tuple"
      }
    ],
    "name": "liquidateLoan",
    "outputs": [
      {
        "internalType": "bytes",
        "name": "",
        "type": "bytes"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "components": [
              {
                "internalType": "uint256",
                "name": "loanId",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "callbackData",
                "type": "bytes"
              },
              {
                "internalType": "bool",
                "name": "shouldDelegate",
                "type": "bool"
              }
            ],
            "internalType": "struct IMultiSourceLoan.SignableRepaymentData",
            "name": "data",
            "type": "tuple"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "borrower",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "nftCollateralTokenId",
                "type": "uint256"
              },
              {
                "internalType": "address",
                "name": "nftCollateralAddress",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "principalAddress",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "principalAmount",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "startTime",
                "type": "uint256"
              },
              {
                "internalType": "uint256",
                "name": "duration",
                "type": "uint256"
              },
              {
                "components": [
                  {
                    "internalType": "uint256",
                    "name": "loanId",
                    "type": "uint256"
                  },
                  {
                    "internalType": "uint256",
                    "name": "floor",
                    "type": "uint256"
                  },
                  {
                    "internalType": "uint256",
                    "name": "principalAmount",
                    "type": "uint256"
                  },
                  {
                    "internalType": "address",
                    "name": "lender",
                    "type": "address"
                  },
                  {
                    "internalType": "uint256",
                    "name": "accruedInterest",
                    "type": "uint256"
                  },
                  {
                    "internalType": "uint256",
                    "name": "startTime",
                    "type": "uint256"
                  },
                  {
                    "internalType": "uint256",
                    "name": "aprBps",
                    "type": "uint256"
                  }
                ],
                "internalType": "struct IMultiSourceLoan.Tranche[]",
                "name": "tranche",
                "type": "tuple[]"
              },
              {
                "internalType": "uint256",
                "name": "protocolFee",
                "type": "uint256"
              },
              {
                "internalType": "bool",
                "name": "lenderRefinanceDisabled",
                "type": "bool"
              }
            ],
            "internalType": "struct IMultiSourceLoan.Loan",
            "name": "loan",
            "type": "tuple"
          },
          {
            "internalType": "bytes",
            "name": "borrowerSignature",
            "type": "bytes"
          }
        ],
        "internalType": "struct IMultiSourceLoan.LoanRepaymentData",
        "name": "_repaymentData",
        "type": "tuple"
      }
    ],
    "name": "repayLoan",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "AddressZeroError",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_lender",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "_offerId",
        "type": "uint256"
      }
    ],
    "name": "CancelledOrExecutedOfferError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CollectionNotWhitelistedError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CurrencyNotWhitelistedError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ECDSAInvalidSignature",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "length",
        "type": "uint256"
      }
    ],
    "name": "ECDSAInvalidSignatureLength",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "s",
        "type": "bytes32"
      }
    ],
    "name": "ECDSAInvalidSignatureS",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_expirationTime",
        "type": "uint256"
      }
    ],
    "name": "ExpiredOfferError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAddressesError",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "_principalAmount",
        "type": "uint256"
      }
    ],
    "name": "InvalidAmountError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidBorrowerError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidCallbackError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidCallerError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidCollateralError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidCollateralIdError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidDurationError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInputError",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_loanId",
        "type": "uint256"
      }
    ],
    "name": "InvalidLoanError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLockPeriodError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidMethodError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidRenegotiationOfferError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSignatureError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTrancheError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LenderRefinanceDisabledError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LoanExpiredError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LoanLockedError",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_expirationTime",
        "type": "uint256"
      }
    ],
    "name": "LoanNotDueError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MaxCapacityExceededError",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "i",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "returndata",
        "type": "bytes"
      }
    ],
    "name": "MulticallFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NFTNotReturnedError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotStrictlyImprovedError",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_pendingProtocolFeeSetTime",
        "type": "uint256"
      }
    ],
    "name": "TooEarlyError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TooManyTranchesError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TooSoonError",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "minTimestamp",
        "type": "uint256"
      }
    ],
    "name": "TrancheCannotBeRefinancedError",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroInterestError",
    "type": "error"
  }
];
