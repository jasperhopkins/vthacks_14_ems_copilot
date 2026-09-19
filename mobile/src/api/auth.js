// Minimal Cognito auth wrapper using amazon-cognito-identity-js (works fine
// in Expo without native modules, unlike the full AWS Amplify SDK).
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from "amazon-cognito-identity-js";
import { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } from "../config";

const userPool = new CognitoUserPool({
  UserPoolId: COGNITO_USER_POOL_ID,
  ClientId: COGNITO_CLIENT_ID,
});

let cachedIdToken = null;

export function login(username, password) {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: userPool });
    const authDetails = new AuthenticationDetails({ Username: username, Password: password });
    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        cachedIdToken = session.getIdToken().getJwtToken();
        resolve(cachedIdToken);
      },
      onFailure: reject,
      // NOTE: if MFA is required (recommended -- see template.yaml
      // MfaConfiguration), handle mfaRequired here and call
      // user.sendMFACode(). Left as a hackathon stretch goal.
    });
  });
}

export function getIdToken() {
  return cachedIdToken;
}
