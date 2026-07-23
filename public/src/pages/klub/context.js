import { createContext, useContext } from 'react'

export const KlubContext = createContext(null)
export function useKlub() {
  return useContext(KlubContext)
}
