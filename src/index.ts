import {} from '@dcl/sdk/math'
import { engine } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { setupUi } from './ui'
import { initPersistenceClient, initPersistenceServer } from './persistenceManager'
import { initLeaderboardNetworkClient, initLeaderboardNetworkServer } from './leaderboardNetwork'
import { initTopMatchesNetworkClient, initTopMatchesNetworkServer } from './topMatchesNetwork'
import { initLeaderboardDisplay3D } from './leaderboardDisplay3D'
import { initPlayquestRotation } from './playquestRotation'

export function main() {
    // isServer() must be read here, inside main() - calling it at module
    // top-level was proven to return a stale/default value even on the
    // authoritative server (see auth-server prototype findings).
    if (isServer()) {
        initPersistenceServer()
        initLeaderboardNetworkServer()
        initTopMatchesNetworkServer()
        return
    }

    initPersistenceClient()
    initLeaderboardNetworkClient()
    initTopMatchesNetworkClient()
    setupUi()
    initLeaderboardDisplay3D()
    initPlayquestRotation()

    // your scene code here
}
