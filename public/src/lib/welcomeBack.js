// The note the registration summary shows when the code just verified belongs to an account that
// already existed: the runner is signed in now, and should know it.

/**
 * @param {{ display_name?: string|null, username?: string|null }|null} user who the session belongs to
 * @returns {string}
 */
export function welcomeBackText(user) {
  const name = (user?.display_name ?? '').trim() || (user?.username ?? '').trim()
  const hello = name ? `Witaj ponownie, ${name}!` : 'Witaj ponownie!'
  return `${hello} Masz już konto w LESZY.RUN i właśnie Cię zalogowaliśmy.`
}
