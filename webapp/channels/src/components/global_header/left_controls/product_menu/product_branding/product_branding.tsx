// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react';
import styled from 'styled-components';

import glyphMap, {ProductChannelsIcon} from '@mattermost/compass-icons/components';
import type {IconGlyphTypes} from '@mattermost/compass-icons/IconGlyphs';
import brainerhubLogoPng from 'images/brainerhub_logo_light.png';

import {useCurrentProduct} from 'utils/products';

const ProductBrandingContainer = styled.span`
    display: flex;
    align-items: center;
`;

const ProductBrandingHeading = styled.span`
    font-family: 'Lato', sans-serif;                        
    font-size: 16px;
    line-height: 24px;
    font-weight: bold;
    margin: 0;
    color: inherit;

    margin-left: 8px;
`;

const ProductBranding = (): JSX.Element => {
    const currentProduct = useCurrentProduct();

    // Render the BrainerHub logo as the main product icon in the header.
    const renderIcon = () => (
        <img
            src={brainerhubLogoPng}
            alt='BrainerHub Logo'
            width={24}
            height={24}
            style={{borderRadius: '4px', objectFit: 'contain'}}
        />
    );

    return (
        <ProductBrandingContainer tabIndex={-1}>
            {/* {renderIcon()} */}
            <h1 className='sr-only'>
                {currentProduct ? currentProduct.switcherText : 'Channels'}
            </h1>
            <ProductBrandingHeading>
                {currentProduct ? currentProduct.switcherText : 'Channels'}
            </ProductBrandingHeading>
        </ProductBrandingContainer>
    );
};

export default ProductBranding;
