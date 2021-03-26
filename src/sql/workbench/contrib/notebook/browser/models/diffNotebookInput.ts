/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileEditorInput } from 'vs/workbench/contrib/files/common/editors/fileEditorInput';
import { SideBySideEditorInput } from 'vs/workbench/common/editor';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { FileNotebookInput } from 'sql/workbench/contrib/notebook/browser/models/fileNotebookInput';

export class DiffNotebookInput extends SideBySideEditorInput {
	public static ID: string = 'workbench.editorinputs.DiffNotebookInput';

	constructor(
		title: string,
		diffInput: DiffEditorInput,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		let originalInput = instantiationService.createInstance(FileNotebookInput, diffInput.primary.getName(), diffInput.primary.resource, diffInput.originalInput as FileEditorInput);
		let modifiedInput = instantiationService.createInstance(FileNotebookInput, diffInput.secondary.getName(), diffInput.secondary.resource, diffInput.modifiedInput as FileEditorInput);
		super(title, diffInput.getTitle(), modifiedInput, originalInput);
		this.setupScrollListeners(originalInput, modifiedInput);
	}

	public getTypeId(): string {
		return DiffNotebookInput.ID;
	}

	/**
	 * Setup scroll listeners so that both the original and modified editors scroll together
	 * @param originalInput original notebook input
	 * @param modifiedInput modified notebook input
	 */
	private setupScrollListeners(originalInput: FileNotebookInput, modifiedInput: FileNotebookInput): void {
		Promise.all([originalInput.containerResolved, modifiedInput.containerResolved]).then(() => {
			originalInput.container.parentElement.parentElement.addEventListener('scroll', () => {
				if (modifiedInput.container) {
					modifiedInput.container.parentElement.parentElement.scroll({ top: originalInput.container.parentElement.parentElement.scrollTop });
				}
			});
			modifiedInput.container.parentElement.parentElement.addEventListener('scroll', () => {
				if (originalInput.container) {
					originalInput.container.parentElement.parentElement.scroll({ top: modifiedInput.container.parentElement.parentElement.scrollTop });
				}
			});
		});
	}
}
