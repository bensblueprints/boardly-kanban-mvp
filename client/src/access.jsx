import {createContext,useContext} from 'react';
export const AccessContext=createContext({workspaceOwner:true});
export const useAccess=()=>useContext(AccessContext);
