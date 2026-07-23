import { createContext, useContext } from 'react'

// Shared profile data for the /profil section views. The Profil layout fetches
// get-profile-data ONCE and provides the result here, so switching tabs never
// refetches or flashes. Sections consume via useProfil().
//
// Shape: { profile, badges, reports, submissions, handleSave,
//          pendingMembership, pendingOwnership, incomingInvites, myClubs, refreshProfileData }
export const ProfilContext = createContext(null)

export function useProfil() {
  const ctx = useContext(ProfilContext)
  if (!ctx) throw new Error('useProfil must be used within the Profil layout')
  return ctx
}
